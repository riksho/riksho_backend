-- B7: PostGIS integration and matching improvements
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE public.driver_locations
  ADD COLUMN IF NOT EXISTS geog geography(Point, 4326);

CREATE INDEX IF NOT EXISTS idx_driver_locations_geog
  ON public.driver_locations USING GIST (geog);

-- Keep geog in sync with lat/lng
CREATE OR REPLACE FUNCTION public.sync_driver_geog()
RETURNS TRIGGER AS $$
BEGIN
  NEW.geog = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_geog ON public.driver_locations;
CREATE TRIGGER trg_sync_geog BEFORE INSERT OR UPDATE ON public.driver_locations
  FOR EACH ROW EXECUTE FUNCTION public.sync_driver_geog();

-- Backfill existing rows
UPDATE public.driver_locations SET geog = ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography WHERE geog IS NULL;

-- radius in meters; returns verified, online, fresh, matching-type drivers
-- excluding any drivers in p_excluded_driver_ids
CREATE OR REPLACE FUNCTION public.nearby_drivers(
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION,
  p_radius_m INT, p_vehicle_type TEXT,
  p_excluded_driver_ids UUID[] DEFAULT '{}'
) RETURNS TABLE (driver_id UUID, distance_m DOUBLE PRECISION) AS $$
  SELECT dl.driver_id,
         ST_Distance(dl.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography) AS distance_m
  FROM public.driver_locations dl
  JOIN public.drivers d ON d.id = dl.driver_id
  JOIN public.vehicles v ON v.driver_id = d.id AND (p_vehicle_type = '' OR v.type = p_vehicle_type)
  WHERE d.status = 'online'
    AND d.is_verified = true
    AND dl.updated_at > NOW() - INTERVAL '2 minutes'
    AND NOT (dl.driver_id = ANY(p_excluded_driver_ids))
    AND ST_DWithin(dl.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography, p_radius_m)
  ORDER BY distance_m ASC
  LIMIT 10;
$$ LANGUAGE sql STABLE;

-- Table to track declines so matching service knows who rejected a ride
CREATE TABLE IF NOT EXISTS public.ride_declines (
  ride_id UUID REFERENCES public.rides(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES public.drivers(id) ON DELETE CASCADE,
  declined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ride_id, driver_id)
);

ALTER TABLE public.ride_declines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can insert own declines"
  ON public.ride_declines FOR INSERT
  WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "Drivers can read own declines"
  ON public.ride_declines FOR SELECT
  USING (auth.uid() = driver_id);

-- Service role will use this to find excluded drivers
