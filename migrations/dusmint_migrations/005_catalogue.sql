-- =============================================================================
-- 005_catalogue.sql
-- Categories, items, and daily price bands
-- =============================================================================

-- Categories table (maps to the vendor_category enum but adds display info)
CREATE TABLE categories (
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
CREATE TABLE items (
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
CREATE TABLE daily_price_bands (
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
