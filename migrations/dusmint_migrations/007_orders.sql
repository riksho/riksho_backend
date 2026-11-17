-- =============================================================================
-- 007_orders.sql
-- Orders, vendor parts, and order items
-- Supports multi-vendor cart (up to 3 vendors per order)
-- =============================================================================

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

CREATE TYPE payment_mode AS ENUM ('prepaid', 'uod');  -- UOD = UPI on Delivery
CREATE TYPE substitution_pref AS ENUM ('replace', 'remove');

CREATE TABLE orders (
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

CREATE TABLE order_vendor_parts (
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
CREATE TYPE order_item_status AS ENUM ('included', 'unavailable', 'substituted');

CREATE TABLE order_items (
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
