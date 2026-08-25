-- Migration: 029_promoters_and_referrals.sql
-- Description: Schema for Brand Promoter role, Driver Referrals, and Promoter Payouts

-- 1. Promoters Table
CREATE TABLE IF NOT EXISTS public.promoters (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    phone TEXT UNIQUE NOT NULL,
    name TEXT,
    email TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    total_earnings INT NOT NULL DEFAULT 0, -- In paise (e.g., 2000 = ₹20)
    withdrawn_amount INT NOT NULL DEFAULT 0, -- In paise
    available_balance INT NOT NULL DEFAULT 0, -- In paise
    total_recruits INT NOT NULL DEFAULT 0,
    upi_id TEXT,
    bank_account_no TEXT,
    bank_ifsc TEXT,
    bank_name TEXT,
    account_holder_name TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at TIMESTAMPTZ
);

-- 2. Promoter Referrals (Driver recruits)
CREATE TABLE IF NOT EXISTS public.promoter_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promoter_id UUID NOT NULL REFERENCES public.promoters(id) ON DELETE CASCADE,
    driver_id UUID UNIQUE NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
    driver_name TEXT NOT NULL,
    driver_phone TEXT NOT NULL,
    reward_amount INT NOT NULL DEFAULT 2000, -- ₹20 in paise
    status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified', 'pending', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Promoter Payout Requests
CREATE TABLE IF NOT EXISTS public.promoter_payout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promoter_id UUID NOT NULL REFERENCES public.promoters(id) ON DELETE CASCADE,
    amount INT NOT NULL, -- In paise
    payout_method TEXT NOT NULL DEFAULT 'upi' CHECK (payout_method IN ('upi', 'bank')),
    upi_id TEXT,
    bank_account_no TEXT,
    bank_ifsc TEXT,
    bank_name TEXT,
    account_holder_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'rejected')),
    transaction_ref TEXT,
    admin_notes TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.promoters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promoter_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promoter_payout_requests ENABLE ROW LEVEL SECURITY;

-- 5. Promoters RLS Policies
DROP POLICY IF EXISTS "Promoters can view own profile" ON public.promoters;
CREATE POLICY "Promoters can view own profile" ON public.promoters
    FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Admins can manage all promoters" ON public.promoters;
CREATE POLICY "Admins can manage all promoters" ON public.promoters
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- 6. Referrals RLS Policies
DROP POLICY IF EXISTS "Promoters can view own referrals" ON public.promoter_referrals;
CREATE POLICY "Promoters can view own referrals" ON public.promoter_referrals
    FOR SELECT USING (auth.uid() = promoter_id);

DROP POLICY IF EXISTS "Admins can manage all referrals" ON public.promoter_referrals;
CREATE POLICY "Admins can manage all referrals" ON public.promoter_referrals
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );

-- 7. Payout Requests RLS Policies
DROP POLICY IF EXISTS "Promoters can view own payout requests" ON public.promoter_payout_requests;
CREATE POLICY "Promoters can view own payout requests" ON public.promoter_payout_requests
    FOR SELECT USING (auth.uid() = promoter_id);

DROP POLICY IF EXISTS "Admins can manage all payout requests" ON public.promoter_payout_requests;
CREATE POLICY "Admins can manage all payout requests" ON public.promoter_payout_requests
    FOR ALL USING (
        (auth.jwt()->>'email' = 'shawsumit6286@gmail.com')
        OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin')
    );
