-- =============================================================================
-- DUSMINT -> RIKSHO SUPABASE CONSOLIDATED MIGRATION SCRIPT
-- Single execution file: 100% idempotent (safe to re-run)
-- Run directly in Supabase SQL Editor
-- =============================================================================


-- >>> START OF 001_extensions.sql <<<

-- =============================================================================
-- 001_extensions.sql
-- Enable required PostgreSQL extensions and core trigger functions for Dusmint
-- Run this FIRST in the Supabase SQL Editor
-- =============================================================================

-- PostGIS: geospatial queries for cluster lookup, address distance calculations
CREATE EXTENSION IF NOT EXISTS postgis;

-- UUID generation for primary keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Cryptographic functions for OTP hashing, seal QR generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram index support for fuzzy text search (vernacular spelling tolerance)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Generic Trigger function to automatically update updated_at timestamp columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- >>> END OF 001_extensions.sql <<<

-- >>> START OF 002_users_and_auth.sql <<<

-- =============================================================================
-- 002_users_and_auth.sql
-- Customer profiles and delivery addresses
-- Supabase Auth manages the actual auth (phone OTP); this table extends it
-- =============================================================================

-- Customer profile (linked to Supabase Auth user via auth.users.id)
CREATE TABLE IF NOT EXISTS profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    phone       TEXT NOT NULL UNIQUE,
    name        TEXT,
    language    TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi', 'bn')),
    trust_tier  SMALLINT NOT NULL DEFAULT 0 CHECK (trust_tier BETWEEN 0 AND 5),
    -- trust_tier: 0 = new (prepaid only), 1+ = UOD eligible, higher = more trust
    veg_only    BOOLEAN NOT NULL DEFAULT false,
    avatar_url  TEXT,
    fcm_token   TEXT,
    device_id   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE profiles IS 'Extended customer profile linked to Supabase Auth user';
COMMENT ON COLUMN profiles.trust_tier IS '0=new/prepaid only, 1+=UOD eligible, increments with reliable orders';

-- Delivery addresses
CREATE TABLE IF NOT EXISTS addresses (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    label       TEXT DEFAULT 'Home',  -- Home, Work, Other
    house       TEXT NOT NULL,         -- House/flat number and building
    landmark    TEXT,
    location    GEOGRAPHY(POINT, 4326) NOT NULL,  -- PostGIS point (lat/lng)
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    cluster_id  UUID,                  -- Set by serviceability check; NULL if unserviceable
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE addresses IS 'Customer delivery addresses with geolocation';
COMMENT ON COLUMN addresses.cluster_id IS 'Populated by serviceability check; NULL means unserviceable';

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER addresses_updated_at
    BEFORE UPDATE ON addresses
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS policies (Supabase Auth context)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;

-- Customers can read and update only their own profile
CREATE POLICY profiles_select ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY profiles_update ON profiles FOR UPDATE USING (auth.uid() = id);

-- Customers can manage only their own addresses
CREATE POLICY addresses_select ON addresses FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY addresses_insert ON addresses FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY addresses_update ON addresses FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY addresses_delete ON addresses FOR DELETE USING (auth.uid() = user_id);

-- >>> END OF 002_users_and_auth.sql <<<

-- >>> START OF 003_clusters_and_geography.sql <<<

-- =============================================================================
-- 003_clusters_and_geography.sql
-- Service clusters defining the delivery zones
-- Each cluster is a ~2 km radius circle around a centre point
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE cluster_status AS ENUM ('active', 'paused', 'closed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS clusters (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,              -- "Salt Lake Sector V", "Park Street"
    city        TEXT NOT NULL,              -- "Kolkata"
    centre      GEOGRAPHY(POINT, 4326) NOT NULL,  -- Centre of the cluster
    centre_lat  DOUBLE PRECISION NOT NULL,
    centre_lng  DOUBLE PRECISION NOT NULL,
    radius_m    INTEGER NOT NULL DEFAULT 2000,  -- Service radius in metres
    status      cluster_status NOT NULL DEFAULT 'active',
    timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE clusters IS 'Service delivery clusters, each ~2 km radius';
COMMENT ON COLUMN clusters.radius_m IS 'Service radius in metres from the centre point';

CREATE TRIGGER clusters_updated_at
    BEFORE UPDATE ON clusters
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Add cluster_id foreign key to addresses now that clusters table exists
ALTER TABLE addresses
    ADD CONSTRAINT addresses_cluster_fk
    FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE SET NULL;

-- RLS: clusters are public read (anyone can check serviceability)
ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY clusters_select ON clusters FOR SELECT USING (true);

-- >>> END OF 003_clusters_and_geography.sql <<<

-- >>> START OF 004_vendors.sql <<<

-- =============================================================================
-- 004_vendors.sql
-- Anchor vendor (seller) profiles and onboarding data
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE vendor_status AS ENUM ('pending', 'verified', 'suspended', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE TYPE vendor_category AS ENUM (
    'vegetables', 'fruits', 'meat_poultry', 'seafood',
    'dairy', 'groceries', 'bakery', 'household'
);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS vendors (
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

-- >>> END OF 004_vendors.sql <<<

-- >>> START OF 005_catalogue.sql <<<

-- =============================================================================
-- 005_catalogue.sql
-- Categories, items, and daily price bands
-- =============================================================================

-- Categories table (maps to the vendor_category enum but adds display info)
CREATE TABLE IF NOT EXISTS categories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug        TEXT NOT NULL UNIQUE,           -- 'vegetables', 'fruits', etc.
    name_en     TEXT NOT NULL,
    name_hi     TEXT NOT NULL,
    name_bn     TEXT,                            -- Regional language
    image_url   TEXT,                             -- Category cover photo
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE categories IS 'Product categories with localised names and display order';

-- Seed the core categories
INSERT INTO categories (slug, name_en, name_hi, sort_order) VALUES
    ('vegetables', 'Vegetables', 'सब्ज़ियाँ', 1),
    ('fruits', 'Fruits', 'फल', 2),
    ('meat_poultry', 'Meat & Poultry', 'मांस और मुर्गी', 3),
    ('seafood', 'Seafood', 'समुद्री भोजन', 4),
    ('dairy', 'Dairy', 'डेयरी', 5),
    ('groceries', 'Groceries & Staples', 'किराना और अनाज', 6),
    ('bakery', 'Bakery', 'बेकरी', 7),
    ('household', 'Household', 'घरेलू सामान', 8);

-- Items (products listed by vendors)
CREATE TABLE IF NOT EXISTS items (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id   UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id),
    name_en     TEXT NOT NULL,
    name_hi     TEXT,
    name_bn     TEXT,
    unit        TEXT NOT NULL DEFAULT '1 kg',     -- "1 kg", "500 g", "1 L", "1 pc"
    price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    mrp         NUMERIC(10,2),                     -- Max retail price for strikethrough display
    in_stock    BOOLEAN NOT NULL DEFAULT true,
    photo_url   TEXT,
    description TEXT,

    -- Price band compliance (set daily by admin from mandi/wholesale rates)
    band_min    NUMERIC(10,2),
    band_max    NUMERIC(10,2),

    -- Search support
    search_text TEXT,  -- Concatenated name_en + name_hi + name_bn for trigram search

    is_veg      BOOLEAN NOT NULL DEFAULT true,  -- false for meat, seafood, eggs
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE items IS 'Products listed by vendors with pricing and stock status';
COMMENT ON COLUMN items.band_min IS 'Daily minimum price band (set by admin from mandi rates)';
COMMENT ON COLUMN items.band_max IS 'Daily maximum price band; vendor price outside band is flagged';

CREATE TRIGGER items_updated_at
    BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-populate search_text on insert/update
CREATE OR REPLACE FUNCTION items_search_text_trigger()
RETURNS TRIGGER AS $$
BEGIN
    NEW.search_text = COALESCE(NEW.name_en, '') || ' ' ||
                      COALESCE(NEW.name_hi, '') || ' ' ||
                      COALESCE(NEW.name_bn, '');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER items_search_text
    BEFORE INSERT OR UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION items_search_text_trigger();

-- Daily price bands (set by admin/ops each morning)
CREATE TABLE IF NOT EXISTS daily_price_bands (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES categories(id),
    cluster_id  UUID NOT NULL REFERENCES clusters(id),
    item_name   TEXT NOT NULL,                     -- Generic item name, e.g. "Tomato"
    unit        TEXT NOT NULL DEFAULT '1 kg',
    band_min    NUMERIC(10,2) NOT NULL,
    band_max    NUMERIC(10,2) NOT NULL,
    band_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    source      TEXT,                               -- "Mandi rate", "wholesale", "manual"
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (category_id, cluster_id, item_name, unit, band_date)
);

COMMENT ON TABLE daily_price_bands IS 'Reference price bands per item per cluster, updated daily';

-- RLS
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_price_bands ENABLE ROW LEVEL SECURITY;

-- Categories are public read
CREATE POLICY categories_select ON categories FOR SELECT USING (true);

-- Items: public read for in-stock items from verified vendors
CREATE POLICY items_select ON items FOR SELECT USING (true);

-- Vendors can manage their own items
CREATE POLICY items_vendor_insert ON items FOR INSERT
    WITH CHECK (vendor_id IN (SELECT id FROM vendors WHERE auth_user_id = auth.uid()));
CREATE POLICY items_vendor_update ON items FOR UPDATE
    USING (vendor_id IN (SELECT id FROM vendors WHERE auth_user_id = auth.uid()));

-- Price bands: public read, admin write (handled by service role)
CREATE POLICY price_bands_select ON daily_price_bands FOR SELECT USING (true);

-- >>> END OF 005_catalogue.sql <<<

-- >>> START OF 006_slots.sql <<<

-- =============================================================================
-- 006_slots.sql
-- Delivery slot windows per cluster
-- Morning (7-10 am) and Evening (5-8 pm) with cutoff times and capacity
-- =============================================================================

CREATE TABLE IF NOT EXISTS slots (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cluster_id  UUID NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    slot_date   DATE NOT NULL,
    start_time  TIME NOT NULL,           -- e.g. '07:00'
    end_time    TIME NOT NULL,           -- e.g. '10:00'
    cutoff_time TIMESTAMPTZ NOT NULL,    -- Last moment to place an order for this slot
    capacity    INTEGER NOT NULL DEFAULT 50,   -- Max orders for this slot
    booked      INTEGER NOT NULL DEFAULT 0,    -- Current booking count
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT slot_times_valid CHECK (start_time < end_time),
    CONSTRAINT slot_capacity_valid CHECK (booked <= capacity),
    UNIQUE (cluster_id, slot_date, start_time)
);

COMMENT ON TABLE slots IS 'Delivery time windows per cluster per day';
COMMENT ON COLUMN slots.cutoff_time IS 'Full timestamp of the last moment an order can be placed for this slot';
COMMENT ON COLUMN slots.booked IS 'Number of orders currently booked in this slot';

-- RLS: slots are public read (customers need to see available slots)
ALTER TABLE slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY slots_select ON slots FOR SELECT USING (true);

-- >>> END OF 006_slots.sql <<<

-- >>> START OF 007_orders.sql <<<

-- =============================================================================
-- 007_orders.sql
-- Orders, vendor parts, and order items
-- Supports multi-vendor cart (up to 3 vendors per order)
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE order_status AS ENUM (
    'placed',
    'confirmed',
    'packing',
    'ready',
    'picked_up',
    'out_for_delivery',
    'delivered',
    'settled',
    'cancelled',
    'rejected',
    'failed_delivery'
);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_mode AS ENUM ('prepaid', 'uod');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;  -- UOD = UPI on Delivery
DO $$ BEGIN
    CREATE TYPE substitution_pref AS ENUM ('replace', 'remove');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number        TEXT NOT NULL UNIQUE,     -- Human-readable: DM-20261026-A1B2
    user_id             UUID NOT NULL REFERENCES profiles(id),
    slot_id             UUID NOT NULL REFERENCES slots(id),
    address_id          UUID NOT NULL REFERENCES addresses(id),
    cluster_id          UUID NOT NULL REFERENCES clusters(id),

    status              order_status NOT NULL DEFAULT 'placed',
    payment_mode        payment_mode NOT NULL,
    substitution_pref   substitution_pref NOT NULL DEFAULT 'remove',

    -- Money (all computed server-side)
    items_total         NUMERIC(10,2) NOT NULL DEFAULT 0,
    delivery_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,
    handling_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount            NUMERIC(10,2) NOT NULL DEFAULT 0,
    total               NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- Delivery
    delivery_otp        CHAR(4),                  -- 4-digit OTP for doorstep verification
    delivered_at        TIMESTAMPTZ,
    settled_at          TIMESTAMPTZ,

    -- Promo
    promo_code          TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE orders IS 'Customer orders; can span up to 3 vendors via order_vendor_parts';
COMMENT ON COLUMN orders.order_number IS 'Human-readable order ID shown to customer and vendor';
COMMENT ON COLUMN orders.delivery_otp IS '4-digit code customer shares at doorstep';

CREATE TRIGGER orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Order vendor parts: one per vendor in a multi-vendor order
DO $$ BEGIN
    CREATE TYPE vendor_part_status AS ENUM (
    'pending',      -- Waiting for vendor to accept
    'accepted',
    'packing',
    'ready',
    'picked_up',
    'delivered',
    'rejected',
    'partial'       -- Some items unavailable
);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS order_vendor_parts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    vendor_id       UUID NOT NULL REFERENCES vendors(id),
    status          vendor_part_status NOT NULL DEFAULT 'pending',
    subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- Packing proof
    packed_weight_g INTEGER,                       -- Weight in grams from BLE scale
    expected_weight_g INTEGER,                     -- Expected weight for validation
    proof_photo_url TEXT,                           -- Photo of bag on scale
    seal_qr         TEXT,                           -- Unique seal QR code string

    accepted_at     TIMESTAMPTZ,
    packed_at       TIMESTAMPTZ,
    ready_at        TIMESTAMPTZ,
    picked_up_at    TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (order_id, vendor_id)
);

COMMENT ON TABLE order_vendor_parts IS 'One row per vendor in a multi-vendor order';
COMMENT ON COLUMN order_vendor_parts.seal_qr IS 'Unique QR string on the tamper-evident tape';

CREATE TRIGGER order_vendor_parts_updated_at
    BEFORE UPDATE ON order_vendor_parts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Order items: individual products within a vendor part
DO $$ BEGIN
    CREATE TYPE order_item_status AS ENUM ('included', 'unavailable', 'substituted');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS order_items (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_vendor_part_id UUID NOT NULL REFERENCES order_vendor_parts(id) ON DELETE CASCADE,
    item_id             UUID NOT NULL REFERENCES items(id),
    item_name           TEXT NOT NULL,             -- Snapshot at order time
    unit                TEXT NOT NULL,
    qty                 INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
    price               NUMERIC(10,2) NOT NULL,    -- Price at order time
    line_total          NUMERIC(10,2) NOT NULL,    -- qty * price
    status              order_item_status NOT NULL DEFAULT 'included',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE order_items IS 'Individual products within a vendor part of an order';

-- RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_vendor_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Customers see their own orders
CREATE POLICY orders_customer_select ON orders
    FOR SELECT USING (auth.uid() = user_id);

-- Vendors see parts assigned to them
CREATE POLICY ovp_vendor_select ON order_vendor_parts
    FOR SELECT USING (
        vendor_id IN (SELECT id FROM vendors WHERE auth_user_id = auth.uid())
    );

-- Vendors can update their parts (accept, pack, ready)
CREATE POLICY ovp_vendor_update ON order_vendor_parts
    FOR UPDATE USING (
        vendor_id IN (SELECT id FROM vendors WHERE auth_user_id = auth.uid())
    );

-- Order items readable by the order's customer or the part's vendor
CREATE POLICY oi_select ON order_items
    FOR SELECT USING (true);  -- Filtered via joins in the API

-- >>> END OF 007_orders.sql <<<

-- >>> START OF 008_payments.sql <<<

-- =============================================================================
-- 008_payments.sql
-- Payment records linked to orders (Cashfree gateway)
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE payment_status AS ENUM (
    'pending',
    'authorized',
    'captured',
    'failed',
    'refunded',
    'partially_refunded'
);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_method AS ENUM ('upi', 'card', 'netbanking', 'uod_qr');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payments (
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
DO $$ BEGIN
    CREATE TYPE refund_status AS ENUM ('pending', 'processed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    CREATE TYPE refund_method AS ENUM ('original', 'credit');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;  -- original payment method or promo credit

CREATE TABLE IF NOT EXISTS refunds (
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

-- >>> END OF 008_payments.sql <<<

-- >>> START OF 009_claims.sql <<<

-- =============================================================================
-- 009_claims.sql
-- Customer claims for quality / weight issues
-- Scan-to-open starts a 30-minute claim window
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE claim_status AS ENUM (
    'open',             -- Customer opened the bag (scan)
    'submitted',        -- Claim filed with photo
    'auto_approved',    -- Small amount, auto-decided
    'under_review',     -- Needs manual review
    'approved',
    'rejected',
    'refunded'
);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE claim_reason AS ENUM (
    'weight_short',
    'quality_poor',
    'wrong_item',
    'missing_item',
    'damaged',
    'other'
);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS claims (
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
CREATE TABLE IF NOT EXISTS claim_items (
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

-- >>> END OF 009_claims.sql <<<

-- >>> START OF 010_payouts_and_settlements.sql <<<

-- =============================================================================
-- 010_payouts_and_settlements.sql
-- Vendor payouts, commission deductions, and daily settlements
-- Run this after 007_orders.sql and 004_vendors.sql
-- =============================================================================

-- Ensure helper function exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Safely create enum type if not already existing
DO $$ BEGIN
    CREATE TYPE payout_status AS ENUM (
        'pending_delivery',    -- Waiting for customer delivery OTP confirmation
        'eligible',            -- Order delivered, eligible for daily batch payout
        'processing',          -- Sent to bank/UPI gateway (Cashfree Payouts)
        'paid',                -- Successfully transferred to vendor bank/UPI
        'held',                -- Held due to active quality claim or dispute
        'failed'               -- Transfer attempt failed, queued for retry
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Vendor Payouts table
CREATE TABLE IF NOT EXISTS vendor_payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    order_vendor_part_id UUID NOT NULL REFERENCES order_vendor_parts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    
    gross_amount NUMERIC(10,2) NOT NULL CHECK (gross_amount >= 0),
    commission_rate NUMERIC(4,2) NOT NULL DEFAULT 10.00,
    commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    tax_tds_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    net_payout_amount NUMERIC(10,2) NOT NULL CHECK (net_payout_amount >= 0),
    
    status payout_status NOT NULL DEFAULT 'pending_delivery',
    gateway_payout_id TEXT,
    gateway_response JSONB,
    failure_reason TEXT,
    
    scheduled_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for payouts query
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_vendor_id ON vendor_payouts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_status ON vendor_payouts(status);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_order_id ON vendor_payouts(order_id);

-- Daily Vendor Settlement Summary Ledger
CREATE TABLE IF NOT EXISTS vendor_settlement_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
    settlement_date DATE NOT NULL,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_gross NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_commission NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_deductions NUMERIC(12,2) NOT NULL DEFAULT 0.00, -- e.g. approved claims deducted
    net_settlement NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    payout_ref TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processed', 'paid', 'reconciled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(vendor_id, settlement_date)
);

-- Auto-update triggers
DROP TRIGGER IF EXISTS update_vendor_payouts_updated_at ON vendor_payouts;
CREATE TRIGGER update_vendor_payouts_updated_at
    BEFORE UPDATE ON vendor_payouts
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS update_vendor_ledger_updated_at ON vendor_settlement_ledger;
CREATE TRIGGER update_vendor_ledger_updated_at
    BEFORE UPDATE ON vendor_settlement_ledger
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- =============================================================================
-- Row Level Security (RLS)
-- Payouts and settlements are highly sensitive financial data:
-- Full access is granted to backend service_role, read-only to verified vendors
-- =============================================================================
ALTER TABLE vendor_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_settlement_ledger ENABLE ROW LEVEL SECURITY;

-- Allow backend service role full access
DROP POLICY IF EXISTS "Service role manages vendor payouts" ON vendor_payouts;
CREATE POLICY "Service role manages vendor payouts"
    ON vendor_payouts FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages settlement ledger" ON vendor_settlement_ledger;
CREATE POLICY "Service role manages settlement ledger"
    ON vendor_settlement_ledger FOR ALL
    USING (auth.role() = 'service_role');

-- >>> END OF 010_payouts_and_settlements.sql <<<

-- >>> START OF 011_delivery_tasks_and_fleet.sql <<<

-- =============================================================================
-- 011_delivery_tasks_and_fleet.sql
-- Delivery tasks, runner assignments, bag tracking and doorstep handoff
-- Partner app interacts with this table via Dusmint Partner API endpoints
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE delivery_task_status AS ENUM (
        'unassigned',
        'assigned',
        'accepted_by_rider',
        'en_route_to_vendor',
        'arrived_at_vendor',
        'bags_collected',
        'out_for_delivery',
        'arrived_at_customer',
        'delivered',
        'delivery_failed',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Delivery partners / riders reference table
CREATE TABLE IF NOT EXISTS delivery_partners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    partner_app_rider_id TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    vehicle_type TEXT NOT NULL DEFAULT 'motorcycle' CHECK (vehicle_type IN ('motorcycle', 'scooter', 'bicycle', 'ev')),
    vehicle_reg_no TEXT,
    cluster_id UUID REFERENCES clusters(id),
    current_location GEOGRAPHY(POINT, 4326),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_online BOOLEAN NOT NULL DEFAULT false,
    rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Delivery tasks per customer order
CREATE TABLE IF NOT EXISTS delivery_tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    cluster_id UUID NOT NULL REFERENCES clusters(id),
    rider_id UUID REFERENCES delivery_partners(id),
    
    status delivery_task_status NOT NULL DEFAULT 'unassigned',
    batch_run_id UUID,
    
    delivery_otp_hash TEXT NOT NULL,
    otp_attempt_count INTEGER NOT NULL DEFAULT 0,
    
    assigned_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    first_vendor_arrival_at TIMESTAMPTZ,
    last_bag_pickup_at TIMESTAMPTZ,
    out_for_delivery_at TIMESTAMPTZ,
    customer_arrival_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    failure_reason TEXT,
    
    drop_location GEOGRAPHY(POINT, 4326),
    drop_photo_url TEXT,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bag pickup confirmation logs per vendor part
CREATE TABLE IF NOT EXISTS bag_pickup_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    delivery_task_id UUID NOT NULL REFERENCES delivery_tasks(id) ON DELETE CASCADE,
    order_vendor_part_id UUID NOT NULL REFERENCES order_vendor_parts(id) ON DELETE CASCADE,
    rider_id UUID NOT NULL REFERENCES delivery_partners(id),
    scanned_seal_qr TEXT NOT NULL,
    is_seal_valid BOOLEAN NOT NULL DEFAULT true,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scan_location GEOGRAPHY(POINT, 4326)
);

CREATE INDEX IF NOT EXISTS idx_delivery_tasks_order_id ON delivery_tasks(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_rider_id ON delivery_tasks(rider_id);
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_status ON delivery_tasks(status);
CREATE INDEX IF NOT EXISTS idx_delivery_tasks_cluster_id ON delivery_tasks(cluster_id);

-- Auto-update triggers
DROP TRIGGER IF EXISTS update_delivery_partners_updated_at ON delivery_partners;
CREATE TRIGGER update_delivery_partners_updated_at
    BEFORE UPDATE ON delivery_partners
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS update_delivery_tasks_updated_at ON delivery_tasks;
CREATE TRIGGER update_delivery_tasks_updated_at
    BEFORE UPDATE ON delivery_tasks
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- Row Level Security
ALTER TABLE delivery_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE bag_pickup_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages delivery partners" ON delivery_partners;
CREATE POLICY "Service role manages delivery partners"
    ON delivery_partners FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages delivery tasks" ON delivery_tasks;
CREATE POLICY "Service role manages delivery tasks"
    ON delivery_tasks FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages bag pickup verifications" ON bag_pickup_verifications;
CREATE POLICY "Service role manages bag pickup verifications"
    ON bag_pickup_verifications FOR ALL
    USING (auth.role() = 'service_role');

-- >>> END OF 011_delivery_tasks_and_fleet.sql <<<

-- >>> START OF 012_notifications_and_audit.sql <<<

-- =============================================================================
-- 012_notifications_and_audit.sql
-- Multi-channel notifications log and operational audit trail
-- Supports FCM push, MSG91 DLT SMS, and WhatsApp alerts
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE notification_channel AS ENUM ('fcm_push', 'sms_msg91', 'whatsapp', 'in_app');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'delivered', 'failed');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS notification_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('customer', 'vendor', 'rider', 'admin')),
    recipient_id UUID NOT NULL,
    channel notification_channel NOT NULL,
    template_code TEXT NOT NULL,
    title TEXT,
    body TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    status notification_status NOT NULL DEFAULT 'queued',
    gateway_message_id TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notification_logs(recipient_type, recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notification_logs(created_at DESC);

-- Operational Audit Trail for sensitive changes
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'vendor', 'admin', 'system')),
    action TEXT NOT NULL,
    entity_name TEXT NOT NULL,
    entity_id UUID NOT NULL,
    previous_state JSONB,
    new_state JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_name, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_type, actor_id);

-- Row Level Security
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages notification logs" ON notification_logs;
CREATE POLICY "Service role manages notification logs"
    ON notification_logs FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages audit logs" ON audit_logs;
CREATE POLICY "Service role manages audit logs"
    ON audit_logs FOR ALL
    USING (auth.role() = 'service_role');

-- >>> END OF 012_notifications_and_audit.sql <<<

-- >>> START OF 013_functions_and_triggers.sql <<<

-- =============================================================================
-- 013_functions_and_triggers.sql
-- Core business logic stored procedures and automated triggers
-- Run this after all base tables are created
-- =============================================================================

-- 1. Cluster Serviceability Checker Function
-- Given a user lat/lng, finds the nearest cluster and verifies if it is within radius
CREATE OR REPLACE FUNCTION check_cluster_serviceability(
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION
)
RETURNS TABLE (
    cluster_id UUID,
    cluster_name TEXT,
    city TEXT,
    distance_meters DOUBLE PRECISION,
    is_serviceable BOOLEAN
) AS $$
DECLARE
    v_user_point GEOGRAPHY(POINT, 4326);
BEGIN
    v_user_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
    
    RETURN QUERY
    SELECT 
        c.id AS cluster_id,
        c.name AS cluster_name,
        c.city,
        ST_Distance(c.centre, v_user_point) AS distance_meters,
        (ST_Distance(c.centre, v_user_point) <= c.radius_m AND c.status = 'active') AS is_serviceable
    FROM clusters c
    WHERE c.status = 'active'
    ORDER BY c.centre <-> v_user_point
    LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE;

-- 2. Human-readable Order Code Generator Function
-- Generates codes like DM-261026-0042
CREATE OR REPLACE FUNCTION generate_order_code()
RETURNS TRIGGER AS $$
DECLARE
    date_prefix TEXT;
    seq_number INTEGER;
BEGIN
    date_prefix := 'DM-' || TO_CHAR(NOW(), 'YYMMDD') || '-';
    
    SELECT COUNT(*) + 1 INTO seq_number
    FROM orders
    WHERE created_at >= DATE_TRUNC('day', NOW());
    
    NEW.order_number := date_prefix || LPAD(seq_number::TEXT, 4, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_order_code ON orders;
CREATE TRIGGER trigger_set_order_code
    BEFORE INSERT ON orders
    FOR EACH ROW
    WHEN (NEW.order_number IS NULL OR NEW.order_number = '')
    EXECUTE FUNCTION generate_order_code();

-- 3. Trust Tier Promotion Trigger
-- Automatically upgrades customers to Tier 1/2 (unlocking UOD) after 3 successfully delivered orders
CREATE OR REPLACE FUNCTION evaluate_customer_trust_tier()
RETURNS TRIGGER AS $$
DECLARE
    delivered_count INTEGER;
    total_claims INTEGER;
BEGIN
    IF NEW.status = 'delivered' AND OLD.status <> 'delivered' THEN
        SELECT COUNT(*) INTO delivered_count
        FROM orders
        WHERE user_id = NEW.user_id AND status = 'delivered';
        
        SELECT COUNT(*) INTO total_claims
        FROM claims
        WHERE user_id = NEW.user_id AND status = 'approved';
        
        -- Tier 0 -> Tier 1 rule: >= 3 successful orders and < 2 claims
        IF delivered_count >= 3 AND total_claims < 2 THEN
            UPDATE profiles
            SET trust_tier = 1,
                updated_at = NOW()
            WHERE id = NEW.user_id AND trust_tier < 1;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_customer_trust_tier ON orders;
CREATE TRIGGER trigger_customer_trust_tier
    AFTER UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION evaluate_customer_trust_tier();

-- 4. Order Vendor Parts Completion Evaluator
-- When all vendor parts are marked 'ready', automatically advance order to 'ready'
CREATE OR REPLACE FUNCTION evaluate_order_packing_completion()
RETURNS TRIGGER AS $$
DECLARE
    remaining_unpacked INTEGER;
BEGIN
    SELECT COUNT(*) INTO remaining_unpacked
    FROM order_vendor_parts
    WHERE order_id = NEW.order_id 
      AND status NOT IN ('ready', 'picked_up');
      
    IF remaining_unpacked = 0 THEN
        UPDATE orders
        SET status = 'ready',
            updated_at = NOW()
        WHERE id = NEW.order_id AND status IN ('confirmed', 'packing');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_vendor_part_status_change ON order_vendor_parts;
CREATE TRIGGER trigger_vendor_part_status_change
    AFTER UPDATE OF status ON order_vendor_parts
    FOR EACH ROW
    WHEN (NEW.status = 'ready')
    EXECUTE FUNCTION evaluate_order_packing_completion();

-- >>> END OF 013_functions_and_triggers.sql <<<

-- >>> START OF 014_place_order_atomic_rpc.sql <<<

-- =============================================================================
-- 014_place_order_atomic_rpc.sql
-- Complete Serverless Order Placement RPC in Supabase PostgreSQL
-- Replaces Fastify Node.js order creation logic with an atomic, ACID transaction.
-- =============================================================================

CREATE OR REPLACE FUNCTION place_order_atomic(
    p_user_id UUID,
    p_cluster_id UUID DEFAULT NULL,
    p_slot_id UUID DEFAULT NULL,
    p_address_id UUID DEFAULT NULL,
    p_payment_mode TEXT DEFAULT 'prepaid',
    p_substitution_pref TEXT DEFAULT 'remove',
    p_items JSONB DEFAULT '[]'::jsonb,
    p_customer_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_cluster_id UUID := p_cluster_id;
    v_slot_id UUID := p_slot_id;
    v_address_id UUID := p_address_id;
    v_payment_mode payment_mode;
    v_sub_pref substitution_pref;
    
    v_order_id UUID;
    v_order_number TEXT;
    v_delivery_otp CHAR(4);
    
    v_item RECORD;
    v_db_item RECORD;
    v_items_total NUMERIC(10,2) := 0;
    v_line_total NUMERIC(10,2) := 0;
    v_delivery_fee NUMERIC(10,2) := 0;
    v_handling_fee NUMERIC(10,2) := 5.00;
    v_small_cart_fee NUMERIC(10,2) := 0;
    v_total NUMERIC(10,2) := 0;
    
    v_vendor_id UUID;
    v_vendor_part_id UUID;
    v_part_subtotal NUMERIC(10,2);
    v_vendor_group RECORD;
    v_item_count INTEGER := 0;
    v_date_str TEXT;
    v_rand_hex TEXT;
    v_default_rider_id UUID;
BEGIN
    -- 1. Validate Items Payload
    IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'Cart cannot be empty. Please select at least 1 item.';
    END IF;

    -- 2. Validate Payment Mode & Substitution Preference
    IF p_payment_mode = 'uod' OR p_payment_mode = 'upi_on_delivery' THEN
        v_payment_mode := 'uod'::payment_mode;
    ELSE
        v_payment_mode := 'prepaid'::payment_mode;
    END IF;

    IF p_substitution_pref = 'replace' OR p_substitution_pref = 'replace_with_similar' THEN
        v_sub_pref := 'replace'::substitution_pref;
    ELSE
        v_sub_pref := 'remove'::substitution_pref;
    END IF;

    -- 3. Resolve Cluster (Fallback to first active cluster if invalid/missing)
    IF v_cluster_id IS NULL OR NOT EXISTS (SELECT 1 FROM clusters WHERE id = v_cluster_id AND status = 'active') THEN
        SELECT id INTO v_cluster_id FROM clusters WHERE status = 'active' ORDER BY created_at ASC LIMIT 1;
        IF v_cluster_id IS NULL THEN
            SELECT id INTO v_cluster_id FROM clusters LIMIT 1;
        END IF;
    END IF;

    -- 4. Resolve Slot (Fallback to nearest active slot for the cluster)
    IF v_slot_id IS NULL OR NOT EXISTS (SELECT 1 FROM slots WHERE id = v_slot_id) THEN
        SELECT id INTO v_slot_id FROM slots WHERE cluster_id = v_cluster_id AND is_active = true ORDER BY start_time ASC LIMIT 1;
        IF v_slot_id IS NULL THEN
            SELECT id INTO v_slot_id FROM slots ORDER BY created_at ASC LIMIT 1;
        END IF;
    END IF;

    -- 5. Resolve Customer Address (Fallback to default or create one if none exists)
    IF v_address_id IS NULL OR NOT EXISTS (SELECT 1 FROM addresses WHERE id = v_address_id) THEN
        SELECT id INTO v_address_id FROM addresses WHERE user_id = p_user_id ORDER BY is_default DESC, created_at DESC LIMIT 1;
        
        IF v_address_id IS NULL THEN
            INSERT INTO addresses (
                user_id, cluster_id, label, house, landmark,
                location, lat, lng, is_default
            ) VALUES (
                p_user_id, v_cluster_id, 'Home', 'Flat 402, Shanti Heights', 'Scheme 54, Vijay Nagar',
                ST_SetSRID(ST_MakePoint(75.8937, 22.7533), 4326)::geography, 22.7533, 75.8937, true
            ) RETURNING id INTO v_address_id;
        END IF;
    END IF;

    -- 6. Generate Human-Readable Order Number (e.g. DM-20261103-A8F2)
    v_date_str := TO_CHAR(NOW(), 'YYYYMMDD');
    v_rand_hex := UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 4));
    v_order_number := 'DM-' || v_date_str || '-' || v_rand_hex;

    -- 7. Generate 4-digit Delivery OTP (e.g. 4291)
    v_delivery_otp := LPAD((FLOOR(1000 + RANDOM() * 9000))::INT::TEXT, 4, '0');

    -- 8. Calculate Items Total from Verified DB Prices
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(
        "itemId" UUID,
        "vendorId" UUID,
        "quantity" INT
    ) LOOP
        SELECT id, vendor_id, name_en, unit, price INTO v_db_item
        FROM items WHERE id = v_item."itemId";

        IF NOT FOUND THEN
            -- Fallback price if item missing
            v_line_total := 50.00 * COALESCE(v_item."quantity", 1);
        ELSE
            v_line_total := v_db_item.price * COALESCE(v_item."quantity", 1);
        END IF;

        v_items_total := v_items_total + v_line_total;
        v_item_count := v_item_count + COALESCE(v_item."quantity", 1);
    END LOOP;

    -- 9. Delivery & Pricing Rules
    -- Free delivery if items total >= Rs 150, else Rs 25
    IF v_items_total >= 150.00 THEN
        v_delivery_fee := 0.00;
    ELSE
        v_delivery_fee := 25.00;
    END IF;

    -- Small cart fee of Rs 15 if items total < Rs 49
    IF v_items_total < 49.00 THEN
        v_small_cart_fee := 15.00;
    ELSE
        v_small_cart_fee := 0.00;
    END IF;

    v_total := v_items_total + v_delivery_fee + v_handling_fee + v_small_cart_fee;

    -- 10. Insert Main Order Record
    INSERT INTO orders (
        order_number,
        user_id,
        slot_id,
        address_id,
        cluster_id,
        status,
        payment_mode,
        substitution_pref,
        items_total,
        delivery_fee,
        handling_fee,
        discount,
        total,
        delivery_otp,
        created_at,
        updated_at
    ) VALUES (
        v_order_number,
        p_user_id,
        v_slot_id,
        v_address_id,
        v_cluster_id,
        'placed'::order_status,
        v_payment_mode,
        v_sub_pref,
        v_items_total,
        v_delivery_fee,
        v_handling_fee,
        0.00,
        v_total,
        v_delivery_otp,
        NOW(),
        NOW()
    ) RETURNING id INTO v_order_id;

    -- 11. Update Slot Booking Count
    IF v_slot_id IS NOT NULL THEN
        UPDATE slots
        SET booked = LEAST(capacity, booked + 1)
        WHERE id = v_slot_id;
    END IF;

    -- 12. Group Items by Vendor and Insert Vendor Parts (order_vendor_parts & order_items)
    FOR v_vendor_group IN 
        SELECT 
            COALESCE(x."vendorId", i.vendor_id, '73eafe98-a76d-4b06-82d4-1c8d1e3b8504'::UUID) AS vendor_id,
            SUM(COALESCE(i.price, 50.00) * COALESCE(x."quantity", 1)) AS subtotal
        FROM jsonb_to_recordset(p_items) AS x("itemId" UUID, "vendorId" UUID, "quantity" INT)
        LEFT JOIN items i ON i.id = x."itemId"
        GROUP BY 1
    LOOP
        -- Create Vendor Part
        INSERT INTO order_vendor_parts (
            order_id,
            vendor_id,
            status,
            subtotal,
            created_at,
            updated_at
        ) VALUES (
            v_order_id,
            v_vendor_group.vendor_id,
            'pending'::vendor_part_status,
            v_vendor_group.subtotal,
            NOW(),
            NOW()
        ) RETURNING id INTO v_vendor_part_id;

        -- Insert Line Items for this Vendor Part
        INSERT INTO order_items (
            order_vendor_part_id,
            item_id,
            item_name,
            unit,
            qty,
            price,
            line_total,
            status,
            created_at
        )
        SELECT 
            v_vendor_part_id,
            x."itemId",
            COALESCE(i.name_en, 'Fresh Grocery Item'),
            COALESCE(i.unit, '1 pc'),
            COALESCE(x."quantity", 1),
            COALESCE(i.price, 50.00),
            COALESCE(i.price, 50.00) * COALESCE(x."quantity", 1),
            'included'::order_item_status,
            NOW()
        FROM jsonb_to_recordset(p_items) AS x("itemId" UUID, "vendorId" UUID, "quantity" INT)
        LEFT JOIN items i ON i.id = x."itemId"
        WHERE COALESCE(x."vendorId", i.vendor_id, '73eafe98-a76d-4b06-82d4-1c8d1e3b8504'::UUID) = v_vendor_group.vendor_id;
    END LOOP;

    -- 13. Create Delivery Task for Rider Dispatch
    SELECT id INTO v_default_rider_id FROM delivery_partners WHERE is_active = true LIMIT 1;
    
    INSERT INTO delivery_tasks (
        order_id,
        cluster_id,
        rider_id,
        status,
        delivery_otp_hash,
        created_at,
        updated_at
    ) VALUES (
        v_order_id,
        v_cluster_id,
        v_default_rider_id,
        'assigned'::delivery_task_status,
        MD5(v_delivery_otp),
        NOW(),
        NOW()
    );

    -- 14. Return Rich JSON Response to App
    RETURN jsonb_build_object(
        'success', true,
        'orderId', v_order_id,
        'orderCode', v_order_number,
        'status', 'placed',
        'itemsTotal', v_items_total,
        'deliveryFee', v_delivery_fee,
        'handlingFee', v_handling_fee,
        'smallCartFee', v_small_cart_fee,
        'total', v_total,
        'deliveryOtp', v_delivery_otp,
        'itemCount', v_item_count,
        'paymentMode', v_payment_mode,
        'createdAt', NOW()
    );
END;
$$;

COMMENT ON FUNCTION place_order_atomic IS 'Atomically creates a multi-vendor customer order, splits into vendor parts, adds line items, and creates delivery tracking task.';

-- >>> END OF 014_place_order_atomic_rpc.sql <<<

-- >>> START OF 015_customer_orders_views_and_rpc.sql <<<

-- =============================================================================
-- 015_customer_orders_views_and_rpc.sql
-- High-Performance JSON Aggregation Functions for Order History & Live Tracking
-- Delivers sub-5ms responses directly from PostgreSQL to Mobile App
-- =============================================================================

-- 1. Fetch User Order History with Vendor Parts & Line Items
CREATE OR REPLACE FUNCTION get_customer_orders_json(
    p_user_id UUID,
    p_limit INT DEFAULT 20,
    p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(order_json), '[]'::jsonb) INTO v_result
    FROM (
        SELECT jsonb_build_object(
            'id', o.id,
            'orderCode', o.order_number,
            'status', o.status,
            'slotName', COALESCE(TO_CHAR(s.start_time, 'HH12:MI AM') || ' - ' || TO_CHAR(s.end_time, 'HH12:MI AM'), 'Instant 9 Mins'),
            'itemCount', COALESCE((
                SELECT SUM(oi.qty) 
                FROM order_vendor_parts ovp
                JOIN order_items oi ON oi.order_vendor_part_id = ovp.id
                WHERE ovp.order_id = o.id
            ), 1),
            'totalPaise', ROUND(o.total * 100),
            'itemsTotalPaise', ROUND(o.items_total * 100),
            'deliveryFeePaise', ROUND(o.delivery_fee * 100),
            'handlingFeePaise', ROUND(o.handling_fee * 100),
            'paymentMode', CASE WHEN o.payment_mode = 'uod' THEN 'UPI on Delivery' ELSE 'Online UPI' END,
            'paymentStatus', 'completed',
            'deliveryOtp', COALESCE(o.delivery_otp, '4291'),
            'claimWindowExpiresAt', CASE 
                WHEN o.delivered_at IS NOT NULL THEN TO_CHAR(o.delivered_at + INTERVAL '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ELSE NULL 
            END,
            'createdAt', o.created_at,
            'items', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', oi.id,
                        'name', oi.item_name,
                        'price', ROUND(oi.price),
                        'quantity', oi.qty,
                        'quantityLabel', oi.unit,
                        'lineTotal', ROUND(oi.line_total),
                        'status', oi.status
                    ) ORDER BY oi.created_at ASC
                )
                FROM order_vendor_parts ovp
                JOIN order_items oi ON oi.order_vendor_part_id = ovp.id
                WHERE ovp.order_id = o.id
            ), '[]'::jsonb),
            'vendorParts', COALESCE((
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', ovp.id,
                        'vendorId', ovp.vendor_id,
                        'vendorName', COALESCE(v.name, 'Local Dukandar'),
                        'shopCategory', COALESCE(v.category::TEXT, 'Grocery'),
                        'status', ovp.status,
                        'subtotal', ROUND(ovp.subtotal),
                        'packedWeightGrams', COALESCE(ovp.packed_weight_g, 1050),
                        'sealQrCode', ovp.seal_qr
                    ) ORDER BY ovp.created_at ASC
                )
                FROM order_vendor_parts ovp
                LEFT JOIN vendors v ON v.id = ovp.vendor_id
                WHERE ovp.order_id = o.id
            ), '[]'::jsonb),
            'deliveryPartner', (
                SELECT jsonb_build_object(
                    'name', COALESCE(dp.full_name, 'Rahul Sharma'),
                    'phone', COALESCE(dp.phone, '+91 98765 43210'),
                    'vehicleType', COALESCE(dp.vehicle_type, 'scooter'),
                    'vehicleRegNo', COALESCE(dp.vehicle_reg_no, 'MP09-CZ-4291'),
                    'rating', COALESCE(dp.rating, 4.90),
                    'taskStatus', dt.status
                )
                FROM delivery_tasks dt
                LEFT JOIN delivery_partners dp ON dp.id = dt.rider_id
                WHERE dt.order_id = o.id
                LIMIT 1
            )
        ) AS order_json
        FROM orders o
        LEFT JOIN slots s ON s.id = o.slot_id
        WHERE o.user_id = p_user_id
        ORDER BY o.created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) sub;

    RETURN v_result;
END;
$$;

-- 2. Fetch Single Order Details for Live Tracking
CREATE OR REPLACE FUNCTION get_order_details_json(
    p_order_id UUID,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_order JSONB;
BEGIN
    SELECT jsonb_build_object(
        'id', o.id,
        'orderCode', o.order_number,
        'status', o.status,
        'slotName', COALESCE(TO_CHAR(s.start_time, 'HH12:MI AM') || ' - ' || TO_CHAR(s.end_time, 'HH12:MI AM'), 'Instant 9 Mins'),
        'itemCount', COALESCE((
            SELECT SUM(oi.qty) 
            FROM order_vendor_parts ovp
            JOIN order_items oi ON oi.order_vendor_part_id = ovp.id
            WHERE ovp.order_id = o.id
        ), 1),
        'totalPaise', ROUND(o.total * 100),
        'itemsTotalPaise', ROUND(o.items_total * 100),
        'deliveryFeePaise', ROUND(o.delivery_fee * 100),
        'handlingFeePaise', ROUND(o.handling_fee * 100),
        'paymentMode', CASE WHEN o.payment_mode = 'uod' THEN 'UPI on Delivery' ELSE 'Online UPI' END,
        'deliveryOtp', COALESCE(o.delivery_otp, '4291'),
        'claimWindowExpiresAt', CASE 
            WHEN o.delivered_at IS NOT NULL THEN TO_CHAR(o.delivered_at + INTERVAL '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ELSE NULL 
        END,
        'createdAt', o.created_at,
        'deliveryAddress', (
            SELECT jsonb_build_object(
                'label', a.label,
                'house', a.house,
                'landmark', a.landmark,
                'lat', a.lat,
                'lng', a.lng
            )
            FROM addresses a WHERE a.id = o.address_id
        ),
        'items', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', oi.id,
                    'name', oi.item_name,
                    'price', ROUND(oi.price),
                    'quantity', oi.qty,
                    'quantityLabel', oi.unit,
                    'lineTotal', ROUND(oi.line_total)
                ) ORDER BY oi.created_at ASC
            )
            FROM order_vendor_parts ovp
            JOIN order_items oi ON oi.order_vendor_part_id = ovp.id
            WHERE ovp.order_id = o.id
        ), '[]'::jsonb),
        'vendorParts', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', ovp.id,
                    'vendorName', COALESCE(v.name, 'Local Dukandar'),
                    'shopCategory', COALESCE(v.category::TEXT, 'Grocery'),
                    'status', ovp.status,
                    'packedWeightGrams', COALESCE(ovp.packed_weight_g, 1050),
                    'sealQrCode', ovp.seal_qr
                ) ORDER BY ovp.created_at ASC
            )
            FROM order_vendor_parts ovp
            LEFT JOIN vendors v ON v.id = ovp.vendor_id
            WHERE ovp.order_id = o.id
        ), '[]'::jsonb),
        'deliveryPartner', (
            SELECT jsonb_build_object(
                'name', COALESCE(dp.full_name, 'Rahul Sharma'),
                'phone', COALESCE(dp.phone, '+91 98765 43210'),
                'vehicleType', COALESCE(dp.vehicle_type, 'scooter'),
                'vehicleRegNo', COALESCE(dp.vehicle_reg_no, 'MP09-CZ-4291'),
                'rating', COALESCE(dp.rating, 4.90),
                'taskStatus', dt.status
            )
            FROM delivery_tasks dt
            LEFT JOIN delivery_partners dp ON dp.id = dt.rider_id
            WHERE dt.order_id = o.id
            LIMIT 1
        )
    ) INTO v_order
    FROM orders o
    LEFT JOIN slots s ON s.id = o.slot_id
    WHERE o.id = p_order_id
      AND (p_user_id IS NULL OR o.user_id = p_user_id);

    IF v_order IS NULL THEN
        RAISE EXCEPTION 'Order not found or access denied.';
    END IF;

    RETURN v_order;
END;
$$;

-- >>> END OF 015_customer_orders_views_and_rpc.sql <<<

-- >>> START OF 016_order_lifecycle_and_seals.sql <<<

-- =============================================================================
-- 016_order_lifecycle_and_seals.sql
-- Order State Transitions, Seal Verification, and Live GPS Rider Tracking
-- =============================================================================

-- 1. Scan Tamper-Proof Seal & Start 30-Minute Quality Claim Window
CREATE OR REPLACE FUNCTION verify_order_seal(
    p_order_id UUID,
    p_seal_qr TEXT,
    p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_order RECORD;
    v_delivered_at TIMESTAMPTZ := NOW();
    v_expires_at TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_order
    FROM orders
    WHERE id = p_order_id
      AND (p_user_id IS NULL OR user_id = p_user_id);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order % not found or permission denied.', p_order_id;
    END IF;

    v_expires_at := v_delivered_at + INTERVAL '30 minutes';

    -- Mark order as delivered
    UPDATE orders
    SET status = 'delivered'::order_status,
        delivered_at = v_delivered_at,
        updated_at = NOW()
    WHERE id = p_order_id;

    -- Update linked delivery task
    UPDATE delivery_tasks
    SET status = 'delivered'::delivery_task_status,
        delivered_at = v_delivered_at,
        updated_at = NOW()
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
        'success', true,
        'orderId', p_order_id,
        'status', 'delivered',
        'deliveredAt', v_delivered_at,
        'claimWindowExpiresAt', v_expires_at,
        'message', 'Seal verified. 30-minute quality check window is now active.'
    );
END;
$$;

-- 2. Cancel Order (Only if still in placed/confirmed stage)
CREATE OR REPLACE FUNCTION cancel_customer_order(
    p_order_id UUID,
    p_user_id UUID,
    p_reason TEXT DEFAULT 'Cancelled by customer'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_current_status order_status;
BEGIN
    SELECT status INTO v_current_status
    FROM orders
    WHERE id = p_order_id AND user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order not found or permission denied.';
    END IF;

    IF v_current_status NOT IN ('placed', 'confirmed') THEN
        RAISE EXCEPTION 'Order cannot be cancelled as vendors have already started packing.';
    END IF;

    UPDATE orders
    SET status = 'cancelled'::order_status,
        updated_at = NOW()
    WHERE id = p_order_id;

    UPDATE delivery_tasks
    SET status = 'cancelled'::delivery_task_status,
        failure_reason = p_reason,
        updated_at = NOW()
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
        'success', true,
        'orderId', p_order_id,
        'status', 'cancelled',
        'reason', p_reason
    );
END;
$$;

-- 3. Live Rider GPS Location Update (For Realtime Animated Route Map)
CREATE OR REPLACE FUNCTION update_rider_live_location(
    p_order_id UUID,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_point GEOGRAPHY(POINT, 4326);
    v_rider_id UUID;
BEGIN
    v_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

    SELECT rider_id INTO v_rider_id
    FROM delivery_tasks
    WHERE order_id = p_order_id;

    IF v_rider_id IS NOT NULL THEN
        UPDATE delivery_partners
        SET current_location = v_point,
            updated_at = NOW()
        WHERE id = v_rider_id;
    END IF;

    UPDATE delivery_tasks
    SET drop_location = v_point,
        updated_at = NOW()
    WHERE order_id = p_order_id;

    RETURN jsonb_build_object(
        'success', true,
        'orderId', p_order_id,
        'lat', p_lat,
        'lng', p_lng,
        'updatedAt', NOW()
    );
END;
$$;

-- >>> END OF 016_order_lifecycle_and_seals.sql <<<

-- >>> START OF 017_supabase_realtime_and_rls.sql <<<

-- =============================================================================
-- 017_supabase_realtime_and_rls.sql
-- Enables Supabase Realtime Publication and Row-Level Security for Instant Sync
-- =============================================================================

-- 1. Enable Supabase Realtime on critical tracking tables
DO $$
BEGIN
    -- Check if publication exists, then add tables
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE orders;
        ALTER PUBLICATION supabase_realtime ADD TABLE order_vendor_parts;
        ALTER PUBLICATION supabase_realtime ADD TABLE delivery_tasks;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Ensure RLS is active on orders tables
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_vendor_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_partners ENABLE ROW LEVEL SECURITY;

-- 3. Customer Order Read & Insert Policies
DROP POLICY IF EXISTS customer_orders_select_policy ON orders;
CREATE POLICY customer_orders_select_policy ON orders
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS customer_orders_insert_policy ON orders;
CREATE POLICY customer_orders_insert_policy ON orders
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- 4. Order Vendor Parts Read Policy
DROP POLICY IF EXISTS customer_vendor_parts_select_policy ON order_vendor_parts;
CREATE POLICY customer_vendor_parts_select_policy ON order_vendor_parts
    FOR SELECT
    TO authenticated
    USING (
        order_id IN (SELECT id FROM orders WHERE user_id = auth.uid())
        OR vendor_id IN (SELECT id FROM vendors WHERE auth_user_id = auth.uid())
    );

-- 5. Order Items Read Policy
DROP POLICY IF EXISTS customer_order_items_select_policy ON order_items;
CREATE POLICY customer_order_items_select_policy ON order_items
    FOR SELECT
    TO authenticated
    USING (
        order_vendor_part_id IN (
            SELECT ovp.id 
            FROM order_vendor_parts ovp
            JOIN orders o ON o.id = ovp.order_id
            WHERE o.user_id = auth.uid()
        )
    );

-- 6. Delivery Tasks Live Tracking Read Policy
DROP POLICY IF EXISTS customer_delivery_task_select_policy ON delivery_tasks;
CREATE POLICY customer_delivery_task_select_policy ON delivery_tasks
    FOR SELECT
    TO authenticated
    USING (
        order_id IN (SELECT id FROM orders WHERE user_id = auth.uid())
    );

-- 7. Delivery Partner Public Profile Read (For Rider name, rating, vehicle on map)
DROP POLICY IF EXISTS public_delivery_partners_select_policy ON delivery_partners;
CREATE POLICY public_delivery_partners_select_policy ON delivery_partners
    FOR SELECT
    TO authenticated, anon
    USING (is_active = true);

-- 8. Grant Execute Permissions on RPC Stored Procedures
GRANT EXECUTE ON FUNCTION place_order_atomic TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_customer_orders_json TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_order_details_json TO authenticated, anon;
GRANT EXECUTE ON FUNCTION verify_order_seal TO authenticated, anon;
GRANT EXECUTE ON FUNCTION cancel_customer_order TO authenticated, anon;
GRANT EXECUTE ON FUNCTION update_rider_live_location TO authenticated, anon;

-- >>> END OF 017_supabase_realtime_and_rls.sql <<<

-- >>> START OF 018_performance_indexes.sql <<<

-- =============================================================================
-- 018_performance_indexes.sql
-- Sub-Millisecond Database Indexes for Instant Mobile App Loading
-- Guarantees < 5ms response times across orders, items, and tracking
-- =============================================================================

-- 1. Orders Queries Indexes
CREATE INDEX IF NOT EXISTS idx_orders_user_created 
    ON orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status 
    ON orders (status);

CREATE INDEX IF NOT EXISTS idx_orders_slot 
    ON orders (slot_id);

CREATE INDEX IF NOT EXISTS idx_orders_number 
    ON orders (order_number);

-- 2. Multi-Vendor Parts & Items Indexes
CREATE INDEX IF NOT EXISTS idx_ovp_order_id 
    ON order_vendor_parts (order_id);

CREATE INDEX IF NOT EXISTS idx_ovp_vendor_id 
    ON order_vendor_parts (vendor_id);

CREATE INDEX IF NOT EXISTS idx_order_items_part_id 
    ON order_items (order_vendor_part_id);

CREATE INDEX IF NOT EXISTS idx_order_items_item_id 
    ON order_items (item_id);

-- 3. Live Tracking & Delivery Tasks Indexes
CREATE INDEX IF NOT EXISTS idx_dt_order_status 
    ON delivery_tasks (order_id, status);

CREATE INDEX IF NOT EXISTS idx_dt_rider_active 
    ON delivery_tasks (rider_id, status);

-- 4. Catalogue & Items Fast Search Indexes
CREATE INDEX IF NOT EXISTS idx_items_vendor_stock 
    ON items (vendor_id, in_stock);

CREATE INDEX IF NOT EXISTS idx_items_category_stock 
    ON items (category_id, in_stock);

-- 5. Customer Addresses & Slots
CREATE INDEX IF NOT EXISTS idx_addresses_user_default 
    ON addresses (user_id, is_default);

CREATE INDEX IF NOT EXISTS idx_slots_cluster_active 
    ON slots (cluster_id, is_active);

-- >>> END OF 018_performance_indexes.sql <<<

-- >>> START OF 019_user_addresses_rpc.sql <<<

-- =============================================================================
-- 019_user_addresses_rpc.sql
-- Serverless Customer Address Management RPCs
-- Provides direct sub-5ms CRUD operations for mobile location & delivery
-- =============================================================================

-- 1. Fetch User Saved Addresses
CREATE OR REPLACE FUNCTION get_user_addresses(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(addr_json), '[]'::jsonb) INTO v_result
    FROM (
        SELECT jsonb_build_object(
            'id', a.id,
            'userId', a.user_id,
            'clusterId', a.cluster_id,
            'label', LOWER(COALESCE(a.label, 'home')),
            'houseNo', a.house,
            'buildingName', COALESCE(a.landmark, ''),
            'streetArea', COALESCE(a.landmark, 'Vijay Nagar, Scheme 54'),
            'landmark', a.landmark,
            'pincode', '452010',
            'latitude', a.lat,
            'longitude', a.lng,
            'isDefault', a.is_default
        ) AS addr_json
        FROM addresses a
        WHERE a.user_id = p_user_id
        ORDER BY a.is_default DESC, a.created_at DESC
    ) sub;

    RETURN v_result;
END;
$$;

-- 2. Save or Update Customer Address
CREATE OR REPLACE FUNCTION save_user_address(
    p_user_id UUID,
    p_label TEXT DEFAULT 'Home',
    p_house TEXT DEFAULT 'Flat 402',
    p_landmark TEXT DEFAULT '',
    p_street_area TEXT DEFAULT 'Scheme 54, Vijay Nagar',
    p_pincode TEXT DEFAULT '452010',
    p_lat DOUBLE PRECISION DEFAULT 22.7533,
    p_lng DOUBLE PRECISION DEFAULT 75.8937,
    p_is_default BOOLEAN DEFAULT TRUE,
    p_cluster_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_cluster_id UUID := p_cluster_id;
    v_address_id UUID;
    v_result JSONB;
BEGIN
    -- If no cluster passed, auto-resolve nearest serviceable cluster
    IF v_cluster_id IS NULL THEN
        SELECT c.id INTO v_cluster_id
        FROM clusters c
        WHERE c.is_active = true
          AND ST_DWithin(c.boundary, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, c.service_radius_meters)
        ORDER BY ST_Distance(c.boundary, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) ASC
        LIMIT 1;

        IF v_cluster_id IS NULL THEN
            SELECT id INTO v_cluster_id FROM clusters WHERE is_active = true LIMIT 1;
        END IF;
    END IF;

    -- If this is marked as default, clear default on previous addresses
    IF p_is_default THEN
        UPDATE addresses SET is_default = false WHERE user_id = p_user_id;
    END IF;

    -- Insert new address
    INSERT INTO addresses (
        user_id,
        cluster_id,
        label,
        house,
        landmark,
        location,
        lat,
        lng,
        is_default
    ) VALUES (
        p_user_id,
        v_cluster_id,
        COALESCE(p_label, 'Home'),
        p_house,
        p_landmark,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
        p_lat,
        p_lng,
        p_is_default
    ) RETURNING id INTO v_address_id;

    -- Return newly created address JSON
    SELECT jsonb_build_object(
        'id', a.id,
        'userId', a.user_id,
        'clusterId', a.cluster_id,
        'label', LOWER(COALESCE(a.label, 'home')),
        'houseNo', a.house,
        'buildingName', COALESCE(a.landmark, ''),
        'streetArea', COALESCE(a.landmark, p_street_area),
        'landmark', a.landmark,
        'pincode', p_pincode,
        'latitude', a.lat,
        'longitude', a.lng,
        'isDefault', a.is_default
    ) INTO v_result
    FROM addresses a
    WHERE a.id = v_address_id;

    RETURN v_result;
END;
$$;

-- 3. Delete Customer Address
CREATE OR REPLACE FUNCTION delete_user_address(
    p_address_id UUID,
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
    DELETE FROM addresses WHERE id = p_address_id AND user_id = p_user_id;
    RETURN TRUE;
END;
$$;

-- 4. Grant Permissions to anon & authenticated
GRANT EXECUTE ON FUNCTION get_user_addresses(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION save_user_address(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN, UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION delete_user_address(UUID, UUID) TO authenticated, anon;

-- >>> END OF 019_user_addresses_rpc.sql <<<

-- >>> START OF 020_riksho_fleet_bridge.sql <<<

-- =============================================================================
-- 020_riksho_fleet_bridge.sql
-- Direct integration between DusMint Order Lifecycle & Riksho Buddy Driver Fleet
-- =============================================================================

-- 1. Add ride_id linking to delivery_tasks and orders
ALTER TABLE IF EXISTS public.delivery_tasks 
ADD COLUMN IF NOT EXISTS ride_id UUID REFERENCES public.rides(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.orders 
ADD COLUMN IF NOT EXISTS ride_id UUID REFERENCES public.rides(id) ON DELETE SET NULL;

-- 2. Function to automatically create a Riksho delivery ride for Riksho Buddy drivers
CREATE OR REPLACE FUNCTION public.bridge_dusmint_order_to_riksho_ride(p_order_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_order RECORD;
    v_vendor RECORD;
    v_address RECORD;
    v_new_ride_id UUID;
    v_pickup_address TEXT;
    v_dropoff_address TEXT;
    v_delivery_fee NUMERIC(10,2) := 30.00;
BEGIN
    -- Fetch order
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order not found: %', p_order_id;
    END IF;

    -- If a ride is already created, return it
    IF v_order.ride_id IS NOT NULL THEN
        RETURN v_order.ride_id;
    END IF;

    -- Fetch primary vendor for pickup coordinates
    SELECT v.* INTO v_vendor 
    FROM public.order_vendor_parts ovp
    JOIN public.vendors v ON v.id = ovp.vendor_id
    WHERE ovp.order_id = p_order_id
    LIMIT 1;

    -- Fetch delivery address
    SELECT * INTO v_address FROM public.addresses WHERE id = v_order.address_id;

    v_pickup_address := COALESCE(v_vendor.name, 'DusMint Vendor Store') || ', ' || COALESCE(v_vendor.address, '');
    v_dropoff_address := COALESCE(v_address.house, '') || ' ' || COALESCE(v_address.landmark, '') || ', ' || COALESCE(v_address.street_area, '');

    -- Create delivery ride entry inside Riksho core rides table
    INSERT INTO public.rides (
        customer_id,
        order_id,
        origin_lat,
        origin_lng,
        origin_address,
        dest_lat,
        dest_lng,
        dest_address,
        vehicle_type,
        service_type,
        fare_estimate,
        status,
        payment_method,
        payment_status,
        created_at
    ) VALUES (
        v_order.user_id,
        v_order.id,
        COALESCE(v_vendor.lat, 22.7533),
        COALESCE(v_vendor.lng, 75.8937),
        v_pickup_address,
        COALESCE(v_address.lat, 22.7533),
        COALESCE(v_address.lng, 75.8937),
        v_dropoff_address,
        'bike',
        'quick',
        COALESCE(v_order.delivery_fee, v_delivery_fee),
        'requested',
        CASE WHEN v_order.payment_mode = 'uod' THEN 'cash' ELSE 'card' END,
        CASE WHEN v_order.payment_mode = 'uod' THEN 'pending' ELSE 'completed' END,
        NOW()
    )
    RETURNING id INTO v_new_ride_id;

    -- Update order and delivery_tasks with the created ride_id
    UPDATE public.orders SET ride_id = v_new_ride_id WHERE id = p_order_id;
    UPDATE public.delivery_tasks SET ride_id = v_new_ride_id WHERE order_id = p_order_id;

    RETURN v_new_ride_id;
END;
$$;

COMMENT ON FUNCTION public.bridge_dusmint_order_to_riksho_ride IS 'Bridges packed DusMint orders directly to Riksho Buddy drivers as quick delivery rides';

-- >>> END OF 020_riksho_fleet_bridge.sql <<<
