-- ============================================================
-- Riksho — Schema Improvements
-- Migration: 002_improvements.sql
-- Date: 2026-07-04
-- Description: Driver verification, earnings ledger, cancellation
--   fees, updated_at trigger, unique rating guard, stale-location
--   support, and optional PostGIS proximity. Idempotent where
--   possible. Review before running — see
--   docs/improvements-backend-security.md §5.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Auto-touch updated_at on every UPDATE
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','drivers','driver_locations','push_tokens']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I;
       CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();', t, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2. Driver verification / approval gate  (§5.2)
-- ------------------------------------------------------------
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'pending'
    CHECK (verification_status IN ('pending','approved','rejected','suspended')),
  ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS rating_sum NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_count INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_drivers_verified_status
  ON public.drivers(is_verified, status);

-- ------------------------------------------------------------
-- 3. Server-authoritative role (do NOT trust JWT metadata)  (§2.1)
-- ------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'customer'
    CHECK (role IN ('customer','driver','admin'));

-- ------------------------------------------------------------
-- 4. Cancellation fees & attribution  (§5.4)
-- ------------------------------------------------------------
ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT
    CHECK (cancelled_by IN ('customer','driver','system')),
  ADD COLUMN IF NOT EXISTS cancellation_fee NUMERIC(10,2) DEFAULT 0;

-- ------------------------------------------------------------
-- 5. Prevent duplicate ratings per side  (§4.2)
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_ratings_ride_by
  ON public.ratings(ride_id, by);

-- ------------------------------------------------------------
-- 6. Earnings / payout ledger  (§5.3)
--   One row per completed ride: gross fare, platform commission,
--   net to driver, and payout tracking.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.earnings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id UUID NOT NULL UNIQUE REFERENCES public.rides(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  gross NUMERIC(10,2) NOT NULL,
  commission NUMERIC(10,2) NOT NULL DEFAULT 0,
  net NUMERIC(10,2) NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  payout_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payout_status IN ('pending','settled','reversed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.earnings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers read own earnings"
  ON public.earnings FOR SELECT
  USING (auth.uid() = driver_id);

CREATE INDEX IF NOT EXISTS idx_earnings_driver ON public.earnings(driver_id);
CREATE INDEX IF NOT EXISTS idx_earnings_created ON public.earnings(created_at);

-- ------------------------------------------------------------
-- 7. Stale-location support for matching  (§3.5)
--   (index only; the backend adds an updated_at filter)
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_driver_locations_updated
  ON public.driver_locations(updated_at);

-- ------------------------------------------------------------
-- 8. Correct driver-rating recompute helper  (§4.1)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_driver_rating(p_driver_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.drivers d
  SET rating = COALESCE(sub.avg, 5.00),
      rating_count = COALESCE(sub.cnt, 0)
  FROM (
    SELECT AVG(r.stars)::NUMERIC(3,2) AS avg, COUNT(*) AS cnt
    FROM public.ratings r
    JOIN public.rides ri ON ri.id = r.ride_id
    WHERE ri.driver_id = p_driver_id AND r.by = 'customer'
  ) sub
  WHERE d.id = p_driver_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 9. OPTIONAL — PostGIS proximity  (§5.5)
--   Uncomment to replace bounding-box matching with true
--   distance. Requires the postgis extension (available on
--   Supabase). Backend then calls nearby_drivers() via RPC.
-- ============================================================
-- CREATE EXTENSION IF NOT EXISTS postgis;
--
-- ALTER TABLE public.driver_locations
--   ADD COLUMN IF NOT EXISTS geog geography(Point, 4326);
--
-- CREATE INDEX IF NOT EXISTS idx_driver_locations_geog
--   ON public.driver_locations USING GIST (geog);
--
-- -- Keep geog in sync with lat/lng
-- CREATE OR REPLACE FUNCTION public.sync_driver_geog()
-- RETURNS TRIGGER AS $$
-- BEGIN
--   NEW.geog = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- DROP TRIGGER IF EXISTS trg_sync_geog ON public.driver_locations;
-- CREATE TRIGGER trg_sync_geog BEFORE INSERT OR UPDATE ON public.driver_locations
--   FOR EACH ROW EXECUTE FUNCTION public.sync_driver_geog();
--
-- -- radius in meters; returns verified, online, fresh, matching-type drivers
-- CREATE OR REPLACE FUNCTION public.nearby_drivers(
--   p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION,
--   p_radius_m INT, p_vehicle_type TEXT
-- ) RETURNS TABLE (driver_id UUID, distance_m DOUBLE PRECISION) AS $$
--   SELECT dl.driver_id,
--          ST_Distance(dl.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography) AS distance_m
--   FROM public.driver_locations dl
--   JOIN public.drivers d ON d.id = dl.driver_id
--   JOIN public.vehicles v ON v.driver_id = d.id AND v.type = p_vehicle_type
--   WHERE d.status = 'online'
--     AND d.is_verified = true
--     AND dl.updated_at > NOW() - INTERVAL '2 minutes'
--     AND ST_DWithin(dl.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography, p_radius_m)
--   ORDER BY distance_m ASC
--   LIMIT 10;
-- $$ LANGUAGE sql STABLE;

-- ============================================================
-- Done!
-- ============================================================
