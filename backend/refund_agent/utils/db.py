"""Database layer: SQLModel models + PostgreSQL engine + seeding from the JSON fixtures.

The mock CRM lives in a real Postgres database (three tables: customers, orders, refunds). On first
run the tables are created and seeded from `data/*.json`. Dates are kept as *relative day offsets*
(e.g. `delivered_days_ago`) and resolved against "today" at read time, so the demo scenarios stay
valid whenever the app is run.

Connection string comes from `DATABASE_URL` (see .env). The refunds table is the gradeable
end-state — an APPROVE writes a row here; a denied refund writes nothing.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Session, SQLModel, create_engine, select

# refund_agent/utils/db.py → backend/data/*.json
DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://refund_app:refund_app@localhost:5432/refund_agent",
)

# One shared Engine for the whole process (a connection pool, NOT a connection). `create_engine`
# does not open a socket, so building it at import is cheap and does not require a live DB — the
# first real connection is made lazily when a Session is used. `engine` is imported by name across
# the app, so it must stay a single module-level object.
engine = create_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,  # transparently drop stale/dead pooled connections before use
    pool_recycle=1800,  # recycle connections before Postgres' idle timeout closes them
)


class Customer(SQLModel, table=True):
    __tablename__ = "customers"
    # Plain indexes on `name` and `email` support fast equality lookups in get_customer.
    # A true functional index on lower(name)/lower(email) is more precise but requires raw DDL;
    # a plain B-tree index is sufficient here because the dataset is small and Postgres will use it
    # for equality scans. ILIKE '%q%' cannot use a B-tree index regardless, so we accept a seqscan
    # only for the loose-name fallback path.
    id: str = Field(primary_key=True)
    name: str = Field(index=True)
    email: str = Field(index=True)
    tier: str
    member_since_days_ago: int
    # historical refund history used for the abuse check (list of {"days_ago": int})
    recent_refunds: list = Field(default_factory=list, sa_column=Column(JSONB))


class Order(SQLModel, table=True):
    __tablename__ = "orders"
    order_id: str = Field(primary_key=True)
    customer_id: str = Field(foreign_key="customers.id", index=True)
    product_name: str
    category: str
    amount: float
    order_days_ago: int
    delivered_days_ago: Optional[int] = None
    status: str
    condition: str
    flags: dict = Field(default_factory=dict, sa_column=Column(JSONB))
    already_refunded: bool = False


class Refund(SQLModel, table=True):
    __tablename__ = "refunds"
    refund_id: str = Field(primary_key=True)
    # UNIQUE, not just indexed: one refund per order. This is what makes record_refund truly
    # idempotent — a concurrent/duplicate insert hits the constraint and is caught (IntegrityError),
    # so a double-click on Approve or two racing turns can never write two refunds for one order.
    order_id: str = Field(index=True, unique=True)
    customer_id: str = Field(index=True)
    amount: float
    reason: str
    created_at: str


class Approval(SQLModel, table=True):
    """A human-in-the-loop approval request raised when the agent escalates a refund."""
    __tablename__ = "approvals"
    id: str = Field(primary_key=True)
    order_id: str = Field(index=True)
    customer_id: str
    amount: float
    reason: str
    # indexed: list_approvals(status=...) / the admin approvals endpoint filter on this hot column
    status: str = Field(default="pending", index=True)  # pending | approved | denied
    created_at: str
    resolved_at: Optional[str] = None
    refund_id: Optional[str] = None


def _seed() -> None:
    """Insert the fixture rows. Assumes the tables are empty."""
    customers = json.loads((DATA_DIR / "customers.json").read_text())
    orders = json.loads((DATA_DIR / "orders.json").read_text())
    with Session(engine) as s:
        for c in customers:
            s.add(Customer(**c))
        for o in orders:
            data = {k: v for k, v in o.items() if k != "_scenario"}
            s.add(Order(**data))
        s.commit()


def init_db() -> None:
    """Create tables if needed and seed once if the CRM is empty."""
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        already_seeded = s.exec(select(Customer)).first() is not None
    if not already_seeded:
        _seed()


def reset_db() -> None:
    """Drop everything and reseed from fixtures (used by tests and the demo reset)."""
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    _seed()
