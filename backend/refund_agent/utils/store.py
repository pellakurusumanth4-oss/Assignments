"""Data-access layer over the PostgreSQL CRM (see db.py).

Exposes the same simple lookups the rest of the app already relies on (`get_customer`, `get_order`,
`record_refund`, …) so nothing downstream changed when we moved from in-memory JSON to a real
database. Every method returns plain dicts (detached from the ORM session), and dates stored as
relative day offsets are resolved against today on read.

The `refunds` table is the gradeable end-state: tests assert against it (tau-bench style) rather
than against chat text.
"""

from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from .db import Approval, Customer, Order, Refund, engine, init_db, reset_db

RETURN_WINDOW_DAYS = 30
DEFECTIVE_WINDOW_DAYS = 90
RESTOCKING_FEE_RATE = 0.15
HIGH_VALUE_THRESHOLD = 500.0
ABUSE_REFUND_LIMIT = 3  # more than this many refunds in 90 days => escalate
ABUSE_WINDOW_DAYS = 90


def _today() -> date:
    """Today's date. Overridable via REFUND_TODAY=YYYY-MM-DD for deterministic tests."""
    override = os.environ.get("REFUND_TODAY")
    if override:
        return datetime.strptime(override, "%Y-%m-%d").date()
    return date.today()


def _iso_days_ago(days: Optional[int]) -> Optional[str]:
    if days is None:
        return None
    return (_today() - timedelta(days=days)).isoformat()


class Store:
    def __init__(self) -> None:
        # Defer schema creation/seeding so a bare `import` never touches the DB. The first method
        # that actually queries calls `_ensure_ready()`, which runs `init_db()` exactly once.
        self._ready = False

    def _ensure_ready(self) -> None:
        if not self._ready:
            init_db()
            self._ready = True

    # ----------------------------------------------------------------- lifecycle
    def reset(self) -> None:
        """Drop + reseed the CRM and clear issued refunds (used by tests / demo reset)."""
        reset_db()
        self._ready = True

    def load(self) -> None:  # kept for backwards compatibility
        self.reset()

    # ---------------------------------------------------------------- customers
    def get_customer(self, query: str) -> Optional[dict[str, Any]]:
        """Find a customer by id, email, or (case-insensitive) name.

        Matching precedence (same semantics as the original scan-based implementation):
          1. Exact match on id, lower(email), or lower(name) — single targeted SQL query.
          2. Loose substring match on lower(name) — one ILIKE query, only reached on miss.

        The plain B-tree index on `name` and `email` (added in db.py) helps the equality pass;
        the ILIKE '%q%' fallback cannot use that index but is only executed when the exact pass
        misses, keeping the common case fast.
        """
        if not query:
            return None
        self._ensure_ready()
        q = query.strip().lower()
        with Session(engine) as s:
            # Pass 1: exact match on id, lower(email), or lower(name) — at most one row returned.
            stmt = select(Customer).where(
                (func.lower(Customer.id) == q)
                | (func.lower(Customer.email) == q)
                | (func.lower(Customer.name) == q)
            )
            c = s.exec(stmt).first()
            if c:
                return self._public_customer(c, s)

            # Pass 2: loose name substring match (e.g. first name only).
            stmt2 = select(Customer).where(func.lower(Customer.name).contains(q))
            c2 = s.exec(stmt2).first()
            if c2:
                return self._public_customer(c2, s)

        return None

    def refunds_last_90_days(self, customer_id: str) -> int:
        self._ensure_ready()
        with Session(engine) as s:
            c = s.get(Customer, customer_id)
            return self._refunds_last_90_days(c, s) if c else 0

    def _refunds_last_90_days(self, c: Customer, s: Session) -> int:
        historical = sum(
            1 for r in (c.recent_refunds or []) if r.get("days_ago", 999) <= ABUSE_WINDOW_DAYS
        )
        # Live refunds must also be bounded to the 90-day window (rule 5.2 says "in the last 90 days").
        # created_at is an ISO timestamp string, so a lexicographic >= against the ISO cutoff is a
        # correct date comparison. Without this, old live refunds would inflate the abuse count forever.
        cutoff = (_today() - timedelta(days=ABUSE_WINDOW_DAYS)).isoformat()
        live = len(
            s.exec(
                select(Refund).where(Refund.customer_id == c.id, Refund.created_at >= cutoff)
            ).all()
        )
        return historical + live

    def _refunds_last_90_days_from_count(self, c: Customer, live_count: int) -> int:
        """Compute the 90-day refund count given a pre-fetched live refund count.

        Used by batch methods (all_customers) to avoid a per-customer DB round-trip.
        """
        historical = sum(
            1 for r in (c.recent_refunds or []) if r.get("days_ago", 999) <= ABUSE_WINDOW_DAYS
        )
        return historical + live_count

    def _public_customer(self, c: Customer, s: Session) -> dict[str, Any]:
        return {
            "id": c.id,
            "name": c.name,
            "email": c.email,
            "tier": c.tier,
            "member_since": _iso_days_ago(c.member_since_days_ago),
            "refunds_last_90_days": self._refunds_last_90_days(c, s),
        }

    def _public_customer_with_count(self, c: Customer, live_refund_count: int) -> dict[str, Any]:
        """Build the public customer dict using a pre-fetched per-customer live refund count.

        Identical shape to `_public_customer`; avoids an extra query per customer in batch paths.
        """
        return {
            "id": c.id,
            "name": c.name,
            "email": c.email,
            "tier": c.tier,
            "member_since": _iso_days_ago(c.member_since_days_ago),
            "refunds_last_90_days": self._refunds_last_90_days_from_count(c, live_refund_count),
        }

    def all_customers(self) -> list[dict[str, Any]]:
        """Return all customers.

        Batch-fetches live refund counts in a single GROUP BY query instead of issuing one
        SELECT per customer (was O(N), now O(1) extra queries — 2 total: one for customers, one
        for the grouped refund counts).
        """
        self._ensure_ready()
        with Session(engine) as s:
            customers = s.exec(select(Customer)).all()

            # Fetch live refund counts (within the 90-day window) for every customer in one shot,
            # matching the per-customer _refunds_last_90_days bound used for the abuse decision.
            cutoff = (_today() - timedelta(days=ABUSE_WINDOW_DAYS)).isoformat()
            count_rows = s.exec(
                select(Refund.customer_id, func.count(Refund.refund_id).label("cnt"))
                .where(Refund.created_at >= cutoff)
                .group_by(Refund.customer_id)
            ).all()
            live_counts: dict[str, int] = {row.customer_id: row.cnt for row in count_rows}

            return [
                self._public_customer_with_count(c, live_counts.get(c.id, 0))
                for c in customers
            ]

    # ------------------------------------------------------------------- orders
    def get_order(self, order_id: str) -> Optional[dict[str, Any]]:
        self._ensure_ready()
        with Session(engine) as s:
            o = s.get(Order, (order_id or "").strip())
            return self._public_order(o, s) if o else None

    def get_orders_for_customer(self, customer_id: str) -> list[dict[str, Any]]:
        self._ensure_ready()
        with Session(engine) as s:
            orders = s.exec(select(Order).where(Order.customer_id == customer_id)).all()
            return [self._public_order(o, s) for o in orders]

    def all_orders(self) -> list[dict[str, Any]]:
        """Return all orders.

        Batch-fetches refunded order ids in a single query instead of one SELECT per order
        (was O(N), now O(1) extra queries — 2 total: one for orders, one for refunded order ids).
        """
        self._ensure_ready()
        with Session(engine) as s:
            orders = s.exec(select(Order)).all()

            # Fetch the set of order_ids that have a live Refund row in one shot.
            refunded_ids: set[str] = {
                row for (row,) in s.exec(select(Refund.order_id)).all()
            }

            return [
                self._public_order_with_refunded(o, refunded_ids)
                for o in orders
            ]

    def _public_order(self, o: Order, s: Session) -> dict[str, Any]:
        refunded = o.already_refunded or (
            s.exec(select(Refund).where(Refund.order_id == o.order_id)).first() is not None
        )
        return {
            "order_id": o.order_id,
            "customer_id": o.customer_id,
            "product_name": o.product_name,
            "category": o.category,
            "amount": o.amount,
            "status": o.status,
            "condition": o.condition,
            "flags": o.flags,
            "order_date": _iso_days_ago(o.order_days_ago),
            "delivered_date": _iso_days_ago(o.delivered_days_ago),
            "days_since_delivered": o.delivered_days_ago,
            "already_refunded": refunded,
        }

    def _public_order_with_refunded(self, o: Order, refunded_ids: set[str]) -> dict[str, Any]:
        """Build the public order dict using a pre-fetched set of refunded order ids.

        Identical shape to `_public_order`; avoids an extra query per order in batch paths.
        """
        refunded = o.already_refunded or (o.order_id in refunded_ids)
        return {
            "order_id": o.order_id,
            "customer_id": o.customer_id,
            "product_name": o.product_name,
            "category": o.category,
            "amount": o.amount,
            "status": o.status,
            "condition": o.condition,
            "flags": o.flags,
            "order_date": _iso_days_ago(o.order_days_ago),
            "delivered_date": _iso_days_ago(o.delivered_days_ago),
            "days_since_delivered": o.delivered_days_ago,
            "already_refunded": refunded,
        }

    def raw_order(self, order_id: str) -> Optional[dict[str, Any]]:
        """Raw order fields the guardrail needs (amount, flags, condition, category, status, …)."""
        self._ensure_ready()
        with Session(engine) as s:
            o = s.get(Order, (order_id or "").strip())
            if not o:
                return None
            return {
                "order_id": o.order_id,
                "customer_id": o.customer_id,
                "product_name": o.product_name,
                "category": o.category,
                "amount": o.amount,
                "order_days_ago": o.order_days_ago,
                "delivered_days_ago": o.delivered_days_ago,
                "status": o.status,
                "condition": o.condition,
                "flags": o.flags,
                "already_refunded": o.already_refunded,
            }

    # ------------------------------------------------------------------ refunds
    def record_refund(
        self, order_id: str, customer_id: str, amount: float, reason: str
    ) -> dict[str, Any]:
        """Record a refund for an order. Idempotent per order: if a refund already exists for
        `order_id` (e.g. a resilience retry replayed `issue_refund`, or two callers raced) the
        existing row is returned unchanged instead of writing a duplicate — no double refund."""
        self._ensure_ready()
        with Session(engine) as s:
            existing = s.exec(select(Refund).where(Refund.order_id == order_id)).first()
            if existing is not None:
                return self._refund_dict(existing)
            record = Refund(
                refund_id=f"rf_{uuid.uuid4().hex[:10]}",
                order_id=order_id,
                customer_id=customer_id,
                amount=round(float(amount), 2),
                reason=reason,
                created_at=datetime.now().isoformat(timespec="seconds"),
            )
            s.add(record)
            try:
                s.commit()
            except IntegrityError:
                # A concurrent writer won the race and inserted the order's refund first; roll back
                # and return their row so the caller still sees exactly one refund for the order.
                s.rollback()
                existing = s.exec(select(Refund).where(Refund.order_id == order_id)).first()
                if existing is not None:
                    return self._refund_dict(existing)
                raise
            s.refresh(record)
            return self._refund_dict(record)

    def issued_refunds(self) -> list[dict[str, Any]]:
        self._ensure_ready()
        with Session(engine) as s:
            return [self._refund_dict(r) for r in s.exec(select(Refund)).all()]

    def refund_for_order(self, order_id: str) -> Optional[dict[str, Any]]:
        self._ensure_ready()
        with Session(engine) as s:
            r = s.exec(select(Refund).where(Refund.order_id == order_id)).first()
            return self._refund_dict(r) if r else None

    def _refund_dict(self, r: Refund) -> dict[str, Any]:
        return {
            "refund_id": r.refund_id,
            "order_id": r.order_id,
            "customer_id": r.customer_id,
            "amount": r.amount,
            "reason": r.reason,
            "created_at": r.created_at,
        }

    # --------------------------------------------------------- approvals (HITL)
    def create_approval(
        self, order_id: str, customer_id: str, amount: float, reason: str
    ) -> dict[str, Any]:
        ap = Approval(
            id=f"ap_{uuid.uuid4().hex[:10]}",
            order_id=order_id,
            customer_id=customer_id,
            amount=round(float(amount), 2),
            reason=reason,
            status="pending",
            created_at=datetime.now().isoformat(timespec="seconds"),
        )
        with Session(engine) as s:
            s.add(ap)
            s.commit()
            s.refresh(ap)
        return self._approval_dict(ap)

    def list_approvals(self, status: Optional[str] = None) -> list[dict[str, Any]]:
        with Session(engine) as s:
            stmt = select(Approval)
            if status:
                stmt = stmt.where(Approval.status == status)
            rows = s.exec(stmt).all()
        rows.sort(key=lambda a: a.created_at, reverse=True)
        return [self._approval_dict(a) for a in rows]

    def get_approval(self, approval_id: str) -> Optional[dict[str, Any]]:
        with Session(engine) as s:
            a = s.get(Approval, approval_id)
            return self._approval_dict(a) if a else None

    def resolve_approval(
        self, approval_id: str, status: str, refund_id: Optional[str] = None
    ) -> Optional[dict[str, Any]]:
        with Session(engine) as s:
            a = s.get(Approval, approval_id)
            if not a:
                return None
            a.status = status
            a.resolved_at = datetime.now().isoformat(timespec="seconds")
            a.refund_id = refund_id
            s.add(a)
            s.commit()
            s.refresh(a)
            return self._approval_dict(a)

    def _approval_dict(self, a: Approval) -> dict[str, Any]:
        return {
            "id": a.id,
            "order_id": a.order_id,
            "customer_id": a.customer_id,
            "amount": a.amount,
            "reason": a.reason,
            "status": a.status,
            "created_at": a.created_at,
            "resolved_at": a.resolved_at,
            "refund_id": a.refund_id,
        }


# Module-level singleton used by the rest of the app.
store = Store()
