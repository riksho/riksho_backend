-- Migration: 025_vehicles_type_check.sql
-- Description: Fix (P3) — vehicles.type still carries the day-one CHECK 
-- constraint ('bike', 'auto', 'car'). This prevents drivers from registering 
-- e_rickshaw, tempo, mini_truck, or truck.

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name
        WHERE tc.table_name = 'vehicles' 
          AND tc.constraint_schema = 'public'
          AND cc.check_clause ILIKE '%type%'
    LOOP
        EXECUTE format('ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS %I;', constraint_name);
    END LOOP;
END
$$;

ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_type_check 
  CHECK (type IN ('bike', 'auto', 'e_rickshaw', 'car', 'tempo', 'mini_truck', 'truck'));
