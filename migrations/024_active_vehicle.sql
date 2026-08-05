-- 024: Add active_vehicle_id to drivers and update matching

-- 1. Add the column
ALTER TABLE public.drivers 
ADD COLUMN IF NOT EXISTS active_vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL;

-- 2. Backfill existing drivers
-- For any driver that has vehicles but no active vehicle, set it to their first vehicle
UPDATE public.drivers d
SET active_vehicle_id = (
  SELECT id FROM public.vehicles v 
  WHERE v.driver_id = d.id 
  ORDER BY created_at ASC 
  LIMIT 1
)
WHERE d.active_vehicle_id IS NULL;

-- 3. Update the matching function
-- We now join the vehicles table explicitly on v.id = d.active_vehicle_id
CREATE OR REPLACE FUNCTION public.nearby_drivers(
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION,
  p_radius_m INT, p_vehicle_type TEXT,
  p_excluded_driver_ids UUID[] DEFAULT '{}'
) RETURNS TABLE (driver_id UUID, distance_m DOUBLE PRECISION) AS $$
  SELECT dl.driver_id,
         ST_Distance(dl.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography) AS distance_m
  FROM public.driver_locations dl
  JOIN public.drivers d ON d.id = dl.driver_id
  JOIN public.vehicles v ON v.id = d.active_vehicle_id AND (p_vehicle_type = '' OR v.type = p_vehicle_type)
  WHERE d.status = 'online'
    AND d.is_verified = true
    AND dl.updated_at > NOW() - INTERVAL '2 minutes'
    AND NOT (dl.driver_id = ANY(p_excluded_driver_ids))
    AND ST_DWithin(dl.geog, ST_SetSRID(ST_MakePoint(p_lng, p_lat),4326)::geography, p_radius_m)
  ORDER BY distance_m ASC
  LIMIT 10;
$$ LANGUAGE sql STABLE;
