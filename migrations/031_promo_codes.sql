-- Migration: 031_promo_codes.sql
-- Description: Schema for Driver Promo Codes & Usable Balance Credit Vouchers

-- 1. Ensure coupon_balance exists on drivers table
ALTER TABLE public.drivers 
ADD COLUMN IF NOT EXISTS coupon_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00;

-- 2. Driver Promo Codes Table
CREATE TABLE IF NOT EXISTS public.driver_promo_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(10) NOT NULL UNIQUE,
    amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
    max_redemptions INT, -- NULL = unlimited
    redemption_count INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Driver Promo Redemptions Table (Audit log + deduplication)
CREATE TABLE IF NOT EXISTS public.driver_promo_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id UUID NOT NULL REFERENCES public.driver_promo_codes(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    code VARCHAR(10) NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_driver_promo_redemption UNIQUE (promo_code_id, driver_id)
);

-- 4. Fast query indexes
CREATE INDEX IF NOT EXISTS idx_driver_promo_codes_code ON public.driver_promo_codes (code);
CREATE INDEX IF NOT EXISTS idx_driver_promo_redemptions_driver_id ON public.driver_promo_redemptions (driver_id);

-- 5. Seed default promotional test vouchers
INSERT INTO public.driver_promo_codes (code, amount, max_redemptions, is_active, description)
VALUES 
    ('RIKSHO50', 50.00, 1000, TRUE, '₹50 Partner Launch Voucher'),
    ('WELCOME19', 19.00, 1000, TRUE, '₹19 Welcome Bonus'),
    ('FREEPASS', 49.00, 1000, TRUE, '₹49 Full Day Pass Credit')
ON CONFLICT (code) DO NOTHING;

-- 6. Enable RLS
ALTER TABLE public.driver_promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_promo_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage promo codes" ON public.driver_promo_codes;
CREATE POLICY "Admins can manage promo codes" ON public.driver_promo_codes
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );

DROP POLICY IF EXISTS "Drivers can view own redemptions" ON public.driver_promo_redemptions;
CREATE POLICY "Drivers can view own redemptions" ON public.driver_promo_redemptions
    FOR SELECT USING (auth.uid() = driver_id);
