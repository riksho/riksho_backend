-- Migration: 030_driver_subscriptions.sql
-- Description: Schema for Buddy Driver Subscription Model (Recharge to Go Online)

-- 1. Subscription Plans Table
CREATE TABLE IF NOT EXISTS public.subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    duration_hours INT NOT NULL,
    original_price INT NOT NULL, -- in paise (e.g. 2900 = ₹29)
    price INT NOT NULL, -- in paise (e.g. 1900 = ₹19)
    badge TEXT, -- e.g. 'best_value', 'popular'
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Seed Default Anchored Plans
INSERT INTO public.subscription_plans (name, duration_hours, original_price, price, badge, is_active, sort_order)
VALUES
    ('5 Hours Trial', 5, 2900, 1900, 'trial', TRUE, 1),
    ('8 Hours Shift', 8, 4900, 2900, NULL, TRUE, 2),
    ('24 Hours Pass', 24, 9900, 4900, 'best_value', TRUE, 3),
    ('7 Days Pass', 168, 49900, 24900, 'weekly_pass', TRUE, 4)
ON CONFLICT DO NOTHING;

-- 3. Driver Subscriptions Table
CREATE TABLE IF NOT EXISTS public.driver_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES public.subscription_plans(id) ON DELETE SET NULL,
    plan_name TEXT,
    duration_hours INT NOT NULL,
    amount_paid INT NOT NULL DEFAULT 0, -- in paise
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'expired', 'failed')),
    started_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Create Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_driver_subs_driver_id_status ON public.driver_subscriptions (driver_id, status);
CREATE INDEX IF NOT EXISTS idx_driver_subs_expires_at ON public.driver_subscriptions (expires_at);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_subscriptions ENABLE ROW LEVEL SECURITY;

-- 6. Subscription Plans RLS Policies
DROP POLICY IF EXISTS "Public can view active subscription plans" ON public.subscription_plans;
CREATE POLICY "Public can view active subscription plans" ON public.subscription_plans
    FOR SELECT USING (is_active = TRUE);

DROP POLICY IF EXISTS "Admins can manage subscription plans" ON public.subscription_plans;
CREATE POLICY "Admins can manage subscription plans" ON public.subscription_plans
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- 7. Driver Subscriptions RLS Policies
DROP POLICY IF EXISTS "Drivers can view own subscriptions" ON public.driver_subscriptions;
CREATE POLICY "Drivers can view own subscriptions" ON public.driver_subscriptions
    FOR SELECT USING (auth.uid() = driver_id);

DROP POLICY IF EXISTS "Admins can manage all subscriptions" ON public.driver_subscriptions;
CREATE POLICY "Admins can manage all subscriptions" ON public.driver_subscriptions
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );
