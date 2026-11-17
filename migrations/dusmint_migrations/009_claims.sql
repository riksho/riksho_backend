-- =============================================================================
-- 009_claims.sql
-- Customer claims for quality / weight issues
-- Scan-to-open starts a 30-minute claim window
-- =============================================================================

CREATE TYPE claim_status AS ENUM (
    'open',             -- Customer opened the bag (scan)
    'submitted',        -- Claim filed with photo
    'auto_approved',    -- Small amount, auto-decided
    'under_review',     -- Needs manual review
    'approved',
    'rejected',
    'refunded'
);

CREATE TYPE claim_reason AS ENUM (
    'weight_short',
    'quality_poor',
    'wrong_item',
    'missing_item',
    'damaged',
    'other'
);

CREATE TABLE claims (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    user_id         UUID NOT NULL REFERENCES profiles(id),
    order_vendor_part_id UUID REFERENCES order_vendor_parts(id),

    status          claim_status NOT NULL DEFAULT 'open',

    -- Seal scan tracking
    seal_qr         TEXT,                           -- The QR that was scanned
    seal_scanned_at TIMESTAMPTZ,                    -- When bag was opened
    claim_window_ends TIMESTAMPTZ,                  -- seal_scanned_at + 30 minutes

    -- Claim details (filled when submitted)
    reason          claim_reason,
    description     TEXT,
    photo_urls      TEXT[],                          -- Evidence photos

    -- Decision
    decision        TEXT,                            -- Auto or manual decision notes
    decided_by      TEXT,                            -- 'auto' or admin user ID
    decided_at      TIMESTAMPTZ,

    -- Refund
    refund_amount   NUMERIC(10,2),
    refund_id       UUID REFERENCES refunds(id),

    -- Fraud scoring
    repeat_claim_count INTEGER DEFAULT 0,            -- How many claims this user has filed
    fraud_score     NUMERIC(4,2) DEFAULT 0.00,       -- Higher = more suspicious

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE claims IS 'Customer quality/weight claims with scan-to-open and 30-min window';
COMMENT ON COLUMN claims.claim_window_ends IS 'Claims submitted after this timestamp are flagged';

CREATE TRIGGER claims_updated_at
    BEFORE UPDATE ON claims
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Claim items: which specific items in the order had issues
CREATE TABLE claim_items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_id    UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    order_item_id UUID NOT NULL REFERENCES order_items(id),
    reason      claim_reason NOT NULL,
    photo_url   TEXT,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE claim_items IS 'Individual items within a claim';

-- RLS
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY claims_customer_select ON claims
    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY claims_customer_insert ON claims
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY claim_items_select ON claim_items
    FOR SELECT USING (
        claim_id IN (SELECT id FROM claims WHERE user_id = auth.uid())
    );
