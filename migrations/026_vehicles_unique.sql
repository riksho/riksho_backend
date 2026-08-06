-- Migration: 026_vehicles_unique.sql
-- Description: Fix (P4) — vehicles table is missing a unique constraint on driver_id,
-- causing POST /drivers/register upsert to fail with 42P10.

-- Deduplicate, preferring the row the driver has actually selected as active.
--
-- Ordering matters here: drivers.active_vehicle_id is declared
-- REFERENCES vehicles(id) ON DELETE SET NULL (024). If we deleted purely by
-- created_at DESC, any driver whose active vehicle happened to be an older
-- duplicate would have active_vehicle_id silently set to NULL. The matching RPC
-- INNER JOINs on that column, so those drivers would vanish from nearby_drivers()
-- entirely — re-introducing P2 for exactly the drivers this migration touches.
WITH ranked AS (
  SELECT v.id,
         ROW_NUMBER() OVER (
             PARTITION BY v.driver_id
             ORDER BY (d.active_vehicle_id = v.id) DESC NULLS LAST,
                      v.created_at DESC
         ) AS rn
  FROM public.vehicles v
  LEFT JOIN public.drivers d ON d.id = v.driver_id
)
DELETE FROM public.vehicles
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Idempotent: migrate.ts re-runs every .sql file on each invocation (no tracking
-- table), so a bare ADD CONSTRAINT would fail with 42710 on the second run.
ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_driver_id_key;

ALTER TABLE public.vehicles
  ADD CONSTRAINT vehicles_driver_id_key UNIQUE (driver_id);

-- Repair any driver left without an active vehicle — either orphaned by an
-- earlier run of this migration's delete, or never backfilled by 024.
-- Without this, such drivers receive zero ride offers with no visible symptom.
UPDATE public.drivers d
SET active_vehicle_id = v.id
FROM public.vehicles v
WHERE v.driver_id = d.id
  AND d.active_vehicle_id IS NULL;
