-- =============================================================================
-- 004_vendors.sql
-- Anchor vendor (seller) profiles and onboarding data
-- =============================================================================

CREATE TYPE vendor_status AS ENUM ('pending', 'verified', 'suspended', 'rejected');
CREATE TYPE vendor_category AS ENUM (
    'vegetables', 'fruits', 'meat_poultry', 'seafood',
    'dairy', 'groceries', 'bakery', 'household'
);

CREATE TABLE vendors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auth_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- Supabase Auth link
    name            TEXT NOT NULL,              -- Shop name
    owner_name      TEXT NOT NULL,
    owner_phone     TEXT NOT NULL UNIQUE,
    category        vendor_category NOT NULL,
    cluster_id      UUID NOT NULL REFERENCES clusters(id),
    location        GEOGRAPHY(POINT, 4326),
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,

    -- Verification documents
    fssai_no        TEXT,
    fssai_expiry    DATE,
    owner_id_type   TEXT,                      -- Aadhaar, PAN, etc.
    owner_id_number TEXT,
    shop_photo_urls TEXT[],                     -- Array of Supabase Storage URLs

    -- Banking
    bank_or_upi     TEXT,                      -- UPI ID or bank account details ref
    payout_mode     TEXT DEFAULT 'upi' CHECK (payout_mode IN ('upi', 'bank')),

    -- Operations
    status          vendor_status NOT NULL DEFAULT 'pending',
    is_open         BOOLEAN NOT NULL DEFAULT false,
    score           NUMERIC(4,2) DEFAULT 0.00 CHECK (score BETWEEN 0 AND 10),
    -- score: rolling composite of fill rate, quality, on-time packing
    commission_pct  NUMERIC(4,2) NOT NULL DEFAULT 10.00,  -- 6-15% by category
    max_orders_per_slot INTEGER DEFAULT 20,

    -- Device
    fcm_token       TEXT,
    language        TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi', 'bn')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at     TIMESTAMPTZ
);

COMMENT ON TABLE vendors IS 'Anchor vendors (sellers) per cluster';
COMMENT ON COLUMN vendors.score IS 'Rolling composite score: fill rate, quality, on-time packing (0-10)';
COMMENT ON COLUMN vendors.commission_pct IS 'Platform commission percentage (6-15% depending on category)';

CREATE TRIGGER vendors_updated_at
    BEFORE UPDATE ON vendors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: vendors can read their own data; public can see basic info of verified vendors
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY vendors_own_select ON vendors
    FOR SELECT USING (auth.uid() = auth_user_id);

CREATE POLICY vendors_public_select ON vendors
    FOR SELECT USING (status = 'verified');

CREATE POLICY vendors_own_update ON vendors
    FOR UPDATE USING (auth.uid() = auth_user_id);
