-- Migration: 035_customer_coin_promo_codes.sql
-- Description: Schema for Customer Riksho Coin Promo Codes & Rewards (Strict 6 Characters)

-- 1. Ensure coins_balance exists on users table
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS coins_balance INT NOT NULL DEFAULT 0;

-- 2. Customer Coin Promo Codes Table (Strictly 6 characters)
CREATE TABLE IF NOT EXISTS public.customer_coin_promo_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(6) NOT NULL UNIQUE,
    coins_amount INT NOT NULL CHECK (coins_amount > 0),
    max_redemptions INT, -- NULL = unlimited
    redemption_count INT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    description TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Customer Coin Redemptions / Transactions
CREATE TABLE IF NOT EXISTS public.customer_coin_promo_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_code_id UUID NOT NULL REFERENCES public.customer_coin_promo_codes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code VARCHAR(6) NOT NULL,
    coins_amount INT NOT NULL,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_customer_coin_redemption UNIQUE (promo_code_id, user_id)
);

-- 4. Fast query indexes
CREATE INDEX IF NOT EXISTS idx_customer_coin_promo_codes_code ON public.customer_coin_promo_codes (code);
CREATE INDEX IF NOT EXISTS idx_customer_coin_promo_redemptions_user_id ON public.customer_coin_promo_redemptions (user_id);

-- 5. Seed default promotional customer coin vouchers (strict 6 characters)
INSERT INTO public.customer_coin_promo_codes (code, coins_amount, max_redemptions, is_active, description)
VALUES 
    ('RIKSHO', 50, 10000, TRUE, '50 Welcome Coins for riders'),
    ('COIN50', 50, 5000, TRUE, '50 Reward Coins Promo'),
    ('WEL100', 100, 2000, TRUE, '100 Special Launch Coins')
ON CONFLICT (code) DO NOTHING;

-- 6. Enable RLS
ALTER TABLE public.customer_coin_promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_coin_promo_redemptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can manage customer promo codes" ON public.customer_coin_promo_codes;
CREATE POLICY "Admins can manage customer promo codes" ON public.customer_coin_promo_codes
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );

DROP POLICY IF EXISTS "Users can view own coin redemptions" ON public.customer_coin_promo_redemptions;
CREATE POLICY "Users can view own coin redemptions" ON public.customer_coin_promo_redemptions
    FOR SELECT USING (auth.uid() = user_id);
