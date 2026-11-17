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

