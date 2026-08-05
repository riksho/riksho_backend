-- Migration: 020_offered_fare.sql
-- Description: Fix (A3) — the customer app has a full fare-stepper UI
--              (find-ride.tsx: adjustFare, ±₹5/₹10/₹20 by vehicle class,
--              labelled "Recommended fare") and sends the result as
--              `offered_fare` on POST /rides. That field existed NOWHERE in the
--              backend: not in RideRequestSchema, not as a column. Zod stripped
--              it silently, the ride was created at the server's fare_estimate,
--              and drivers were shown the base fare instead of what the customer
--              offered. A customer raising their fare to attract a driver in the
--              rain had that intent thrown away.
--
--              This migration adds the column so the offer can be persisted,
--              broadcast to drivers as the headline number, and settled against
--              at completion.
--
-- Idempotent: safe to re-run.
--
-- Design notes:
--   * NULLABLE on purpose. `offered_fare` is a "move" (cab/bike) concept — it is
--     customer bidding. Fleet jobs are contract-priced and quick-commerce
--     deliveries are fee-priced, so those rows legitimately leave it NULL and
--     fall back to fare_estimate. Do NOT add a default.
--   * No CHECK constraint on the value. The acceptable band is relative to that
--     row's fare_estimate (0.8x–2.0x), which a column CHECK cannot express
--     cleanly across updates. Clamping is enforced server-side in
--     POST /rides where both numbers are in scope, so a hand-crafted API call
--     cannot bypass it.

ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS offered_fare NUMERIC(10,2);

COMMENT ON COLUMN public.rides.offered_fare IS
  'Customer-offered fare from the find-ride stepper (move rides only). Clamped '
  'server-side to 0.8x-2.0x of fare_estimate. NULL for fleet/quick jobs, which '
  'settle against fare_estimate instead. When set, this — not fare_estimate — is '
  'the number shown to drivers and the basis for the fare_final clamp at completion.';

-- ------------------------------------------------------------
-- Verification (run manually after applying):
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'rides' AND column_name = 'offered_fare';
--   -- expect: offered_fare | numeric | YES
-- ------------------------------------------------------------
