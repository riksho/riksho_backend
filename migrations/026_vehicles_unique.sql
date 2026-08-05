-- Migration: 026_vehicles_unique.sql
-- Description: Fix (P4) — vehicles table is missing a unique constraint on driver_id, 
-- causing POST /drivers/register upsert to fail with 42P10.

-- We delete duplicates first, keeping the newest active_vehicle_id or latest created_at
-- to ensure we can successfully add the UNIQUE constraint.

WITH duplicates AS (
  SELECT id,
         ROW_NUMBER() OVER (
             PARTITION BY driver_id 
             ORDER BY created_at DESC
         ) as rn
  FROM public.vehicles
)
DELETE FROM public.vehicles
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- Now safe to add unique constraint
ALTER TABLE public.vehicles 
  ADD CONSTRAINT vehicles_driver_id_key UNIQUE (driver_id);
