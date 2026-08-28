-- Migration 034: ride_bids table for inDrive-style fare negotiation
-- Each driver can submit one bid per ride (upsert on ride_id + driver_id).
-- The customer picks from the live list via POST /rides/:id/select-bid.

-- 1. Create the ride_bids table
CREATE TABLE IF NOT EXISTS ride_bids (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  eta_min INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'rejected', 'won')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- A driver can only have one bid per ride; re-submitting updates in place.
  UNIQUE (ride_id, driver_id)
);

-- 2. Index for fast bid-list lookup by ride
CREATE INDEX IF NOT EXISTS idx_ride_bids_ride_id ON ride_bids (ride_id);

-- 3. Index for checking a driver's active bids quickly
CREATE INDEX IF NOT EXISTS idx_ride_bids_driver_status ON ride_bids (driver_id, status);

-- 4. Enable RLS (keep admin-only for now; all access goes through the backend service role)
ALTER TABLE ride_bids ENABLE ROW LEVEL SECURITY;

-- Service-role bypass: supabaseAdmin (service_role key) skips RLS automatically,
-- so no explicit policy is needed for backend access. If direct client access is
-- ever required, add policies here.

-- 5. Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_ride_bids_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ride_bids_updated_at
  BEFORE UPDATE ON ride_bids
  FOR EACH ROW
  EXECUTE FUNCTION update_ride_bids_updated_at();
