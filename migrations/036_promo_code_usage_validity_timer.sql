-- Migration: 036_promo_code_usage_validity_timer.sql
-- Description: Add usage_validity_hours to driver and customer promo codes for countdown timers after claiming

-- 1. Add usage_validity_hours to driver_promo_codes
ALTER TABLE public.driver_promo_codes
ADD COLUMN IF NOT EXISTS usage_validity_hours INT CHECK (usage_validity_hours IS NULL OR usage_validity_hours > 0);

-- 2. Add usage_validity_hours to customer_coin_promo_codes
ALTER TABLE public.customer_coin_promo_codes
ADD COLUMN IF NOT EXISTS usage_validity_hours INT CHECK (usage_validity_hours IS NULL OR usage_validity_hours > 0);

-- 3. Add expires_at to customer_coin_promo_redemptions
ALTER TABLE public.customer_coin_promo_redemptions
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
