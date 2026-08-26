-- Migration: 032_promo_code_types.sql
-- Description: Add support for both Credit Promo Codes (₹) and Free Access Pass Promo Codes (Days)

-- 1. Add type, duration_days, and plan_name to driver_promo_codes
ALTER TABLE public.driver_promo_codes
ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'credit',
ADD COLUMN IF NOT EXISTS duration_days INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS plan_name VARCHAR(100) DEFAULT NULL;

-- Allow amount to be 0 for free pass promo codes
ALTER TABLE public.driver_promo_codes DROP CONSTRAINT IF EXISTS driver_promo_codes_amount_check;
ALTER TABLE public.driver_promo_codes ADD CONSTRAINT driver_promo_codes_amount_check CHECK (amount >= 0);

-- 2. Add type, duration_days, and subscription_id to driver_promo_redemptions
ALTER TABLE public.driver_promo_redemptions
ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'credit',
ADD COLUMN IF NOT EXISTS duration_days INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES public.driver_subscriptions(id) ON DELETE SET NULL;

-- 3. Seed sample free pass promo code (e.g. 7-day free pass)
INSERT INTO public.driver_promo_codes (code, type, duration_days, plan_name, amount, max_redemptions, is_active, description)
VALUES 
    ('FREE7DAYS', 'free_pass', 7, 'Free 7-Day Access Pass', 0.00, 1000, TRUE, '7 Days Unlimited Free Platform Access'),
    ('FREE30DAYS', 'free_pass', 30, 'Free 30-Day Partner Pass', 0.00, 500, TRUE, '30 Days Unlimited Free Platform Access')
ON CONFLICT (code) DO NOTHING;
