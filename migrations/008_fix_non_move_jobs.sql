-- 008_fix_non_move_jobs.sql
-- Fixes the systemic "NOT NULL customer_id" failure for Fleet (API + scheduled)
-- and Quick delivery rides, which have no end-user customer.
-- Also adds business_id/idempotency support and delivery SLA timestamps.

-- 1. rides.customer_id must be nullable — API shipments and quick-delivery
--    dispatch rides are created by the system/business, not an end customer.
ALTER TABLE rides ALTER COLUMN customer_id DROP NOT NULL;

-- 2. Integrity guard: a ride must be attributable to *someone* so we never
--    create a fully-orphaned job. Fleet can be owned by a customer (in-app
--    booking) OR a business (API/scheduled); quick is owned via order_id.
ALTER TABLE rides DROP CONSTRAINT IF EXISTS check_job_ownership;
ALTER TABLE rides ADD CONSTRAINT check_job_ownership CHECK (
  customer_id IS NOT NULL OR business_id IS NOT NULL OR order_id IS NOT NULL
);

-- 3. Quick delivery SLA timestamps on the order (replaces the planned 008 rider_id;
--    ride_id already links the delivery ride from migration 007).
ALTER TABLE quick_orders ADD COLUMN IF NOT EXISTS packed_at timestamptz;
ALTER TABLE quick_orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- NOTE: The live fare/delivery-fee engine reads from src/modules/fares/fares.config.ts
-- (hardcoded), NOT from the fare_config table (which is limited to bike/auto/car by a
-- CHECK constraint and is effectively vestigial). The Quick delivery fee is therefore
-- defined in code (QUICK_DELIVERY_FEE) rather than seeded here.

-- 5. RPC: Atomic Inventory Release (mirror of reserve_inventory from 007).
--    Used to roll back a failed checkout and to release on cancellation,
--    without the fetch-then-update race the JS implementation had.
CREATE OR REPLACE FUNCTION release_inventory(p_darkstore_id uuid, p_items jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  item record;
BEGIN
  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(product_id uuid, qty integer)
  LOOP
    UPDATE darkstore_inventory
    SET
      qty_available = qty_available + item.qty,
      qty_reserved  = GREATEST(0, qty_reserved - item.qty),
      updated_at = now()
    WHERE darkstore_id = p_darkstore_id AND product_id = item.product_id;
  END LOOP;
  RETURN true;
END;
$$;
