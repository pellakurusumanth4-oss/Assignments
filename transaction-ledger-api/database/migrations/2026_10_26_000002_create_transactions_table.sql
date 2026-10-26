-- Idempotent: every migration runs on each server start.

CREATE TABLE IF NOT EXISTS transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id),
  type         text NOT NULL CHECK (type IN ('credit', 'debit')),
  amount       numeric(18, 2) NOT NULL CHECK (amount > 0),
  description  text NOT NULL DEFAULT '',
  reference_id text NOT NULL CHECK (btrim(reference_id) <> ''),
  -- clock_timestamp(), not now(): stamped after the account lock is taken,
  -- so history order matches the order the balance actually changed.
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS transactions_history_idx
  ON transactions (account_id, created_at DESC, id DESC);

-- Ledger entries are append-only: block edits and deletes even from outside the API.
CREATE OR REPLACE FUNCTION reject_transaction_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'transactions are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_transaction_change();
