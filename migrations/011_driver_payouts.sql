-- Migration 011: Driver Payouts
-- Creates a ledger for weekly payouts.

CREATE TABLE IF NOT EXISTS driver_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID REFERENCES drivers(id) NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    gross NUMERIC(10,2) NOT NULL DEFAULT 0,
    commission NUMERIC(10,2) NOT NULL DEFAULT 0,
    net NUMERIC(10,2) NOT NULL DEFAULT 0,
    status TEXT CHECK (status IN ('pending', 'paid', 'failed')) DEFAULT 'pending',
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for querying driver payouts by period
CREATE INDEX IF NOT EXISTS idx_driver_payouts_driver_id_start ON driver_payouts(driver_id, period_start);

-- RLS
ALTER TABLE driver_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can view their own payouts"
    ON driver_payouts FOR SELECT
    USING (auth.uid() = driver_id);
    
-- Note: Service role (admin scripts) bypasses RLS to INSERT/UPDATE payouts.

-- Earnings ledger (earnings table) already exists per prior migrations, but ensuring rides has tracking if needed.
-- We rely on the existing earnings table (populated on ride completion) to aggregate driver_payouts.
