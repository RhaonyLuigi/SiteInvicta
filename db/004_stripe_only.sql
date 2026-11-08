CREATE SCHEMA IF NOT EXISTS integration_archive;
REVOKE ALL ON SCHEMA integration_archive FROM PUBLIC;
CREATE TABLE IF NOT EXISTS integration_archive.receivers (
    org_id uuid PRIMARY KEY,
    data jsonb NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO integration_archive.receivers(org_id,data)
SELECT id,jsonb_build_object('account_id',mp_user_id,'access_token',mp_access_token,'refresh_token',mp_refresh_token,'expires_at',mp_expires_at)
FROM organizations WHERE mp_user_id IS NOT NULL OR mp_access_token IS NOT NULL
ON CONFLICT(org_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS integration_archive.authorization_states (
    token_hash text PRIMARY KEY,
    data jsonb NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO integration_archive.authorization_states(token_hash,data)
SELECT token_hash,to_jsonb(s) FROM oauth_states s ON CONFLICT(token_hash) DO NOTHING;
CREATE TABLE IF NOT EXISTS integration_archive.orders (
    order_id uuid PRIMARY KEY,
    data jsonb NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO integration_archive.orders(order_id,data)
SELECT id,to_jsonb(o) FROM orders o WHERE payment_provider NOT IN ('stripe','mock')
ON CONFLICT(order_id) DO NOTHING;
REVOKE ALL ON ALL TABLES IN SCHEMA integration_archive FROM PUBLIC;
UPDATE orders SET status='expired',checkout_lease_until=NULL WHERE payment_provider NOT IN ('stripe','mock') AND status='pending';
ALTER TABLE orders ALTER COLUMN payment_provider SET DEFAULT 'stripe';
DROP TABLE IF EXISTS oauth_states;
ALTER TABLE organizations DROP COLUMN IF EXISTS mp_access_token;
ALTER TABLE organizations DROP COLUMN IF EXISTS mp_refresh_token;
ALTER TABLE organizations DROP COLUMN IF EXISTS mp_expires_at;
ALTER TABLE organizations DROP COLUMN IF EXISTS mp_user_id;
ALTER TABLE orders DROP COLUMN IF EXISTS preference_id;
ALTER TABLE orders DROP COLUMN IF EXISTS checkout_url;
CREATE INDEX IF NOT EXISTS orders_stripe_reconciliation_idx ON orders(reconciled_at,created_at) WHERE payment_provider='stripe';
