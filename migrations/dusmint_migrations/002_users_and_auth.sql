-- =============================================================================
-- 002_users_and_auth.sql
-- Customer profiles and delivery addresses
-- Supabase Auth manages the actual auth (phone OTP); this table extends it
-- =============================================================================

-- Customer profile (linked to Supabase Auth user via auth.users.id)
CREATE TABLE profiles (
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
CREATE TABLE addresses (
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
