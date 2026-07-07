-- Phase 3: Quick Commerce (Storefront & Inventory)

-- 1. Dark Stores
CREATE TABLE darkstores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  lat numeric NOT NULL,
  lng numeric NOT NULL,
  service_radius_km numeric NOT NULL DEFAULT 5,
  city text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 2. Products (Central Catalog)
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL,
  image_url text,
  price numeric NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 3. Inventory
CREATE TABLE darkstore_inventory (
  darkstore_id uuid REFERENCES darkstores(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  qty_available integer NOT NULL DEFAULT 0,
  qty_reserved integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (darkstore_id, product_id)
);

-- 4. Quick Orders
CREATE TABLE quick_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  darkstore_id uuid NOT NULL REFERENCES darkstores(id),
  ride_id uuid REFERENCES rides(id), -- The delivery ride (populated in Phase 4)
  status text NOT NULL DEFAULT 'placed', -- placed, accepted, picking, packed, out_for_delivery, delivered, cancelled
  item_total numeric NOT NULL,
  delivery_fee numeric NOT NULL,
  total numeric NOT NULL,
  delivery_address text NOT NULL,
  delivery_lat numeric NOT NULL,
  delivery_lng numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 5. Order Items
CREATE TABLE quick_order_items (
  order_id uuid REFERENCES quick_orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  qty integer NOT NULL,
  unit_price numeric NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- 6. RPC: Atomic Inventory Reservation
-- This function attempts to reserve inventory for a cart. If successful, returns true. If stock is insufficient, returns false.
CREATE OR REPLACE FUNCTION reserve_inventory(p_darkstore_id uuid, p_items jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item record;
  current_qty integer;
BEGIN
  -- p_items is a JSON array: [{"product_id": "uuid", "qty": 1}, ...]
  
  -- Iterate through items and check/lock rows
  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(product_id uuid, qty integer)
  LOOP
    -- Lock the specific row for update to prevent concurrent modification
    SELECT qty_available INTO current_qty
    FROM darkstore_inventory
    WHERE darkstore_id = p_darkstore_id AND product_id = item.product_id
    FOR UPDATE;

    IF current_qty IS NULL OR current_qty < item.qty THEN
      -- Insufficient stock, rollback transaction (which happens by raising exception, but we want to return false gracefully)
      -- In Postgres, raising an exception rolls back. Since we can't catch it and return false easily in a pure function without subtransactions,
      -- we will just RAISE EXCEPTION. The backend will catch the 500/400.
      RAISE EXCEPTION 'Insufficient stock for product %', item.product_id;
    END IF;

    -- Update inventory
    UPDATE darkstore_inventory
    SET 
      qty_available = qty_available - item.qty,
      qty_reserved = qty_reserved + item.qty,
      updated_at = now()
    WHERE darkstore_id = p_darkstore_id AND product_id = item.product_id;
  END LOOP;

  RETURN true;
END;
$$;

-- RLS Policies
ALTER TABLE darkstores ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE darkstore_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE quick_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE quick_order_items ENABLE ROW LEVEL SECURITY;

-- Allow public read for catalog and stores
CREATE POLICY "Public read darkstores" ON darkstores FOR SELECT USING (true);
CREATE POLICY "Public read products" ON products FOR SELECT USING (true);
CREATE POLICY "Public read inventory" ON darkstore_inventory FOR SELECT USING (true);

-- Customers can view their own orders
CREATE POLICY "Customers view own orders" ON quick_orders FOR SELECT USING (auth.uid() = customer_id);
CREATE POLICY "Customers view own order items" ON quick_order_items FOR SELECT USING (
  order_id IN (SELECT id FROM quick_orders WHERE customer_id = auth.uid())
);
