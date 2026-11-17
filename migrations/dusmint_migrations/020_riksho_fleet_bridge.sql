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
