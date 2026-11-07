CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_links (
    token_hash text PRIMARY KEY,
    email text NOT NULL,
    name text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    fee_bps integer CHECK (fee_bps BETWEEN 0 AND 2000),
    fee_mode text NOT NULL DEFAULT 'included' CHECK (fee_mode IN ('included','added')),
    mp_user_id text UNIQUE,
    mp_access_token text,
    mp_refresh_token text,
    mp_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
    org_id uuid NOT NULL REFERENCES organizations(id),
    user_id uuid NOT NULL REFERENCES users(id),
    role text NOT NULL CHECK (role IN ('owner','manager','checkin')),
    PRIMARY KEY(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
    token_hash text PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id),
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('manager','checkin')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE TABLE IF NOT EXISTS oauth_states (
    token_hash text PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES organizations(id),
    user_id uuid NOT NULL REFERENCES users(id),
    verifier text NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES organizations(id),
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    place text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    capacity integer NOT NULL CHECK (capacity > 0),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','cancelled')),
    cover_url text NOT NULL DEFAULT '/assets/atmosfera-invicta.webp',
    refund_policy text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS events_public_idx ON events(status,starts_at);
CREATE INDEX IF NOT EXISTS events_org_idx ON events(org_id,created_at);
CREATE TABLE IF NOT EXISTS lots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events(id),
    name text NOT NULL,
    category text NOT NULL,
    description text NOT NULL DEFAULT '',
    price_cents integer NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000),
    capacity integer NOT NULL CHECK (capacity > 0),
    sales_start timestamptz NOT NULL,
    sales_end timestamptz NOT NULL,
    closed boolean NOT NULL DEFAULT false,
    CHECK (sales_end > sales_start)
);
CREATE INDEX IF NOT EXISTS lots_event_idx ON lots(event_id);
CREATE TABLE IF NOT EXISTS orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    event_id uuid NOT NULL REFERENCES events(id),
    lot_id uuid NOT NULL REFERENCES lots(id),
    idempotency_key text NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
    subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
    fee_cents integer NOT NULL CHECK (fee_cents >= 0),
    total_cents integer NOT NULL CHECK (total_cents >= 0),
    fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 2000),
    fee_mode text NOT NULL CHECK (fee_mode IN ('included','added')),
    currency text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','cancelled','refund_pending','refunded','charged_back')),
    expires_at timestamptz NOT NULL,
    paid_payment_id text,
    preference_id text,
    checkout_url text,
    checkout_lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS orders_stock_idx ON orders(event_id,lot_id,status,expires_at);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id,created_at);
CREATE TABLE IF NOT EXISTS payments (
    provider_id text PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders(id),
    status text NOT NULL,
    amount_cents integer NOT NULL,
    provider_fee_cents integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments(order_id);
CREATE TABLE IF NOT EXISTS tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL REFERENCES orders(id),
    sequence integer NOT NULL,
    checked_at timestamptz,
    checked_by uuid REFERENCES users(id),
    UNIQUE(order_id,sequence)
);
CREATE TABLE IF NOT EXISTS subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint text NOT NULL UNIQUE,
    keys jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id);
CREATE TABLE IF NOT EXISTS notices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id),
    dedupe_key text NOT NULL UNIQUE,
    title text NOT NULL,
    body text NOT NULL,
    url text NOT NULL,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notices_user_idx ON notices(user_id,created_at);
CREATE TABLE IF NOT EXISTS jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dedupe_key text NOT NULL UNIQUE,
    kind text NOT NULL CHECK (kind IN ('email','push','refund')),
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_pending_idx ON jobs(status,next_at);
CREATE TABLE IF NOT EXISTS audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid REFERENCES organizations(id),
    actor_id uuid REFERENCES users(id),
    action text NOT NULL,
    entity_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits (
    key text PRIMARY KEY,
    hits integer NOT NULL DEFAULT 1,
    expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS refund_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
    created_at timestamptz NOT NULL DEFAULT now()
);
