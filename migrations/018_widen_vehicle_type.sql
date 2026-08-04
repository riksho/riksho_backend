-- Migration: 018_widen_vehicle_type.sql
-- Description: Fix (A2) — rides.vehicle_type and fare_config.vehicle_type still carry
--              the original day-one CHECK (bike, auto, car) from 001_initial_schema.sql.
--              Meanwhile the customer app sells e_rickshaw (with an "ECO" badge) and
--              RideRequestSchema accepts 7 types. Any ride requested as e_rickshaw /
--              tempo / mini_truck / truck is rejected by Postgres, surfacing to the
--              customer as a generic 500 "Failed to create ride".
--
-- Idempotent: safe to re-run.
--
-- NOTE ON CONSTRAINT NAMES: 001 declared these CHECKs inline, so Postgres
-- auto-generated the names. Rather than guessing "rides_vehicle_type_check",
-- we discover and drop *every* CHECK constraint that references the
-- vehicle_type column on each table, then add ours back with an explicit name.
-- This makes the migration correct regardless of what the generated names are.

-- ------------------------------------------------------------
-- 1. rides.vehicle_type
-- ------------------------------------------------------------
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'rides'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%vehicle_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.rides DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'Dropped CHECK constraint on rides.vehicle_type: %', c.conname;
  END LOOP;
END $$;

ALTER TABLE public.rides
  ADD CONSTRAINT rides_vehicle_type_check
  CHECK (vehicle_type IS NULL OR vehicle_type IN
    ('bike', 'auto', 'e_rickshaw', 'car', 'tempo', 'mini_truck', 'truck'));

-- ------------------------------------------------------------
-- 2. fare_config.vehicle_type
--   Same stale constraint at 001_initial_schema.sql:234. vehicle_type is the
--   PRIMARY KEY here, so it is NOT NULL by definition — no NULL branch needed.
-- ------------------------------------------------------------
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'fare_config'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%vehicle_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.fare_config DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'Dropped CHECK constraint on fare_config.vehicle_type: %', c.conname;
  END LOOP;
END $$;

ALTER TABLE public.fare_config
  ADD CONSTRAINT fare_config_vehicle_type_check
  CHECK (vehicle_type IN
    ('bike', 'auto', 'e_rickshaw', 'car', 'tempo', 'mini_truck', 'truck'));

-- ------------------------------------------------------------
-- 3. Seed fare_config rows for the newly-permitted types.
--   001 seeded only bike/auto/car. FARE_CONFIG in fares.config.ts is the
--   authoritative source at runtime (the table is not currently read by the
--   fare engine), but keeping them in sync avoids confusion for anyone who
--   later switches to DB-driven pricing. Values mirror fares.config.ts.
-- ------------------------------------------------------------
INSERT INTO public.fare_config (vehicle_type, base_fare, per_km, per_min, minimum_fare) VALUES
  ('e_rickshaw',  25,  10,  1.2,  40),
  ('tempo',      150,  25,  3.0, 250),
  ('mini_truck', 250,  35,  4.0, 400),
  ('truck',      500,  50,  5.0, 800)
ON CONFLICT (vehicle_type) DO NOTHING;

-- ------------------------------------------------------------
-- Verification (run manually after applying):
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'rides_vehicle_type_check';
--   -- expect all 7 types listed
--
--   SELECT vehicle_type FROM public.fare_config ORDER BY vehicle_type;
--   -- expect 7 rows
-- ------------------------------------------------------------
