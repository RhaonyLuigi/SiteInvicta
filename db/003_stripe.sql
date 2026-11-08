ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_account_id text UNIQUE;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_ready boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'mercadopago';
CREATE TABLE IF NOT EXISTS checkout_sessions (
    order_id uuid NOT NULL REFERENCES orders(id),
    method text NOT NULL CHECK (method IN ('pix','card')),
    session_id text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(order_id,method)
);
