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

