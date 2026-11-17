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
