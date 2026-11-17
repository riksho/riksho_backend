-- =============================================================================
-- 008_payments.sql
-- Payment records linked to orders (Cashfree gateway)
-- =============================================================================

CREATE TYPE payment_status AS ENUM (
    'pending',
    'authorized',
    'captured',
    'failed',
    'refunded',
    'partially_refunded'
);

CREATE TYPE payment_method AS ENUM ('upi', 'card', 'netbanking', 'uod_qr');

CREATE TABLE payments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    mode            payment_mode NOT NULL,          -- prepaid or uod
    method          payment_method,                 -- Actual method used
    status          payment_status NOT NULL DEFAULT 'pending',
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),

    -- Cashfree references
    gateway_order_id TEXT,                           -- Cashfree order ID
    gateway_payment_id TEXT,                         -- Cashfree payment ID
    gateway_ref     TEXT,                            -- Bank reference / UTR
    cf_payment_session TEXT,                         -- Session token sent to app

    -- UOD specific
    uod_qr_payload  TEXT,                            -- Dynamic UPI QR payload
    uod_collected_at TIMESTAMPTZ,                    -- When doorstep payment confirmed

    -- Idempotency
    idempotency_key TEXT UNIQUE,                     -- Prevent duplicate charges

    webhook_payload JSONB,                           -- Raw webhook for audit
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE payments IS 'Payment transactions linked to orders via Cashfree';
COMMENT ON COLUMN payments.idempotency_key IS 'Ensures retried payment calls do not double-charge';

CREATE TRIGGER payments_updated_at
    BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Refunds table (separate from payments for auditability)
CREATE TYPE refund_status AS ENUM ('pending', 'processed', 'failed');
CREATE TYPE refund_method AS ENUM ('original', 'credit');  -- original payment method or promo credit

CREATE TABLE refunds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id      UUID NOT NULL REFERENCES payments(id),
    order_id        UUID NOT NULL REFERENCES orders(id),
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    reason          TEXT NOT NULL,
    status          refund_status NOT NULL DEFAULT 'pending',
    method          refund_method NOT NULL DEFAULT 'original',
    gateway_refund_id TEXT,
    idempotency_key TEXT UNIQUE,
    initiated_by    TEXT NOT NULL DEFAULT 'system',  -- 'system', 'admin', 'auto_claim'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ
);

COMMENT ON TABLE refunds IS 'Refund transactions; always initiated server-side with idempotency';

-- RLS
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY payments_customer_select ON payments
    FOR SELECT USING (
        order_id IN (SELECT id FROM orders WHERE user_id = auth.uid())
    );

CREATE POLICY refunds_customer_select ON refunds
    FOR SELECT USING (
        order_id IN (SELECT id FROM orders WHERE user_id = auth.uid())
    );
