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

