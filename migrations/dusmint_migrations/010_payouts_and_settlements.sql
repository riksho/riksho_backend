-- =============================================================================
-- 010_payouts_and_settlements.sql
-- Vendor payouts, commission deductions, and daily settlements
-- Run this after 007_orders.sql and 004_vendors.sql
-- =============================================================================

-- Ensure helper function exists
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Safely create enum type if not already existing
DO $$ BEGIN
    CREATE TYPE payout_status AS ENUM (
        'pending_delivery',    -- Waiting for customer delivery OTP confirmation
        'eligible',            -- Order delivered, eligible for daily batch payout
        'processing',          -- Sent to bank/UPI gateway (Cashfree Payouts)
        'paid',                -- Successfully transferred to vendor bank/UPI
        'held',                -- Held due to active quality claim or dispute
        'failed'               -- Transfer attempt failed, queued for retry
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Vendor Payouts table
CREATE TABLE IF NOT EXISTS vendor_payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    order_vendor_part_id UUID NOT NULL REFERENCES order_vendor_parts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    
    gross_amount NUMERIC(10,2) NOT NULL CHECK (gross_amount >= 0),
    commission_rate NUMERIC(4,2) NOT NULL DEFAULT 10.00,
    commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    tax_tds_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    net_payout_amount NUMERIC(10,2) NOT NULL CHECK (net_payout_amount >= 0),
    
    status payout_status NOT NULL DEFAULT 'pending_delivery',
    gateway_payout_id TEXT,
    gateway_response JSONB,
    failure_reason TEXT,
    
    scheduled_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for payouts query
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_vendor_id ON vendor_payouts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_status ON vendor_payouts(status);
CREATE INDEX IF NOT EXISTS idx_vendor_payouts_order_id ON vendor_payouts(order_id);

-- Daily Vendor Settlement Summary Ledger
CREATE TABLE IF NOT EXISTS vendor_settlement_ledger (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
    settlement_date DATE NOT NULL,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_gross NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_commission NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_deductions NUMERIC(12,2) NOT NULL DEFAULT 0.00, -- e.g. approved claims deducted
    net_settlement NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    payout_ref TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processed', 'paid', 'reconciled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(vendor_id, settlement_date)
);

-- Auto-update triggers
DROP TRIGGER IF EXISTS update_vendor_payouts_updated_at ON vendor_payouts;
CREATE TRIGGER update_vendor_payouts_updated_at
    BEFORE UPDATE ON vendor_payouts
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

DROP TRIGGER IF EXISTS update_vendor_ledger_updated_at ON vendor_settlement_ledger;
CREATE TRIGGER update_vendor_ledger_updated_at
    BEFORE UPDATE ON vendor_settlement_ledger
    FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- =============================================================================
-- Row Level Security (RLS)
-- Payouts and settlements are highly sensitive financial data:
-- Full access is granted to backend service_role, read-only to verified vendors
-- =============================================================================
ALTER TABLE vendor_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_settlement_ledger ENABLE ROW LEVEL SECURITY;

-- Allow backend service role full access
DROP POLICY IF EXISTS "Service role manages vendor payouts" ON vendor_payouts;
CREATE POLICY "Service role manages vendor payouts"
    ON vendor_payouts FOR ALL
    USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages settlement ledger" ON vendor_settlement_ledger;
CREATE POLICY "Service role manages settlement ledger"
    ON vendor_settlement_ledger FOR ALL
    USING (auth.role() = 'service_role');
