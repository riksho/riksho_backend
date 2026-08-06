-- Migration: 025_vehicles_type_check.sql
-- Description: Fix (P3) — vehicles.type still carries the day-one CHECK 
-- constraint ('bike', 'auto', 'car'). This prevents drivers from registering 
-- e_rickshaw, tempo, mini_truck, or truck.

-- Discover the day-one constraint by definition rather than by name (it was
-- declared inline in 001, so its name is whatever Postgres auto-assigned).
--
-- Read from pg_constraint with contype = 'c' rather than
-- information_schema.check_constraints: the latter also lists NOT NULL
-- pseudo-constraints, and `type IS NOT NULL` matches a '%type%' filter. On
-- Postgres 17+ those are real droppable catalog entries, so a looser filter
-- risks silently dropping NOT NULL from vehicles.type.
DO $$
DECLARE
    con_name TEXT;
BEGIN
    FOR con_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'vehicles'
          AND n.nspname = 'public'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%type%'
    LOOP
        EXECUTE format('ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS %I;', con_name);
    END LOOP;
END
$$;

-- Idempotent: migrate.ts re-runs every .sql file on each invocation (no tracking
-- table), so a bare ADD CONSTRAINT would fail with 42710 on the second run.
ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_type_check;

ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_type_check
  CHECK (type IN ('bike', 'auto', 'e_rickshaw', 'car', 'tempo', 'mini_truck', 'truck'));
