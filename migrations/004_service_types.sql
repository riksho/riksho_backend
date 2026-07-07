-- 004_service_types.sql
-- Transition from rides to generic jobs (Phase 0)

-- 1. users: Add account_type
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type text DEFAULT 'personal';
ALTER TABLE users ADD CONSTRAINT check_account_type CHECK (account_type IN ('personal', 'business'));

-- 2. drivers: Add partner_type
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS partner_type text DEFAULT 'cab_bike';
ALTER TABLE drivers ADD CONSTRAINT check_partner_type CHECK (partner_type IN ('cab_bike', 'fleet', 'quick_rider'));

-- 3. vehicles: Add capacity_kg for fleet
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS capacity_kg integer;

-- 4. rides: Make it a generic "jobs" table
ALTER TABLE rides ADD COLUMN IF NOT EXISTS service_type text DEFAULT 'move';
ALTER TABLE rides ADD CONSTRAINT check_service_type CHECK (service_type IN ('move', 'fleet', 'quick'));

ALTER TABLE rides ADD COLUMN IF NOT EXISTS business_id uuid;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cargo_weight_kg integer;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS order_id uuid;

-- Optional: Create a view for readability
CREATE OR REPLACE VIEW jobs AS SELECT * FROM rides;
