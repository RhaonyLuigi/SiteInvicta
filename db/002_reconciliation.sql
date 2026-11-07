ALTER TABLE orders ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
CREATE INDEX IF NOT EXISTS orders_reconciliation_idx ON orders(reconciled_at,created_at) WHERE preference_id IS NOT NULL;
