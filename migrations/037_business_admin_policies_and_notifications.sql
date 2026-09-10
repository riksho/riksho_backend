-- 037_business_admin_policies_and_notifications.sql
-- 1. Ensure RLS policies on businesses table allow Admins full visibility & update capabilities
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

-- Drop old policies if existing to avoid conflicts
DROP POLICY IF EXISTS "Admins can view all businesses" ON public.businesses;
DROP POLICY IF EXISTS "Admins can update all businesses" ON public.businesses;
DROP POLICY IF EXISTS "Admins can delete all businesses" ON public.businesses;
DROP POLICY IF EXISTS "Users can view their own businesses" ON public.businesses;
DROP POLICY IF EXISTS "Users can insert their own businesses" ON public.businesses;
DROP POLICY IF EXISTS "Users can update their own businesses" ON public.businesses;

-- Owner policies
CREATE POLICY "Users can view their own businesses"
  ON public.businesses FOR SELECT
  USING (auth.uid() = owner_user_id);

CREATE POLICY "Users can insert their own businesses"
  ON public.businesses FOR INSERT
  WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "Users can update their own businesses"
  ON public.businesses FOR UPDATE
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- Admin policies
CREATE POLICY "Admins can view all businesses"
  ON public.businesses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'admin'
    )
  );

CREATE POLICY "Admins can update all businesses"
  ON public.businesses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'admin'
    )
  );

-- 2. Add indexes for high-speed queries on businesses
CREATE INDEX IF NOT EXISTS idx_businesses_owner_user_id ON public.businesses(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_businesses_status ON public.businesses(status);
CREATE INDEX IF NOT EXISTS idx_businesses_phone ON public.businesses(phone);
CREATE INDEX IF NOT EXISTS idx_businesses_email ON public.businesses(email);
CREATE INDEX IF NOT EXISTS idx_businesses_gstin ON public.businesses(gstin);

-- 3. Notification log table for business communications
CREATE TABLE IF NOT EXISTS public.business_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  recipient_phone TEXT,
  recipient_email TEXT,
  notification_type TEXT NOT NULL, -- 'approval_sms', 'approval_email', 'rejection_sms', 'rejection_email'
  status TEXT NOT NULL DEFAULT 'sent', -- 'sent', 'failed', 'simulated'
  title TEXT,
  message TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.business_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read business_notifications"
  ON public.business_notifications FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'admin'
    )
  );

-- 4. Check if an email or phone belongs to a registered business
CREATE OR REPLACE FUNCTION is_business_registered(lookup_value text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  clean_val text;
BEGIN
  IF lookup_value IS NULL OR trim(lookup_value) = '' THEN
    RETURN FALSE;
  END IF;

  clean_val := trim(lookup_value);

  RETURN EXISTS (
    SELECT 1 FROM public.businesses
    WHERE (email IS NOT NULL AND lower(trim(email)) = lower(clean_val))
       OR (phone IS NOT NULL AND replace(replace(replace(replace(phone, '+91', ''), '+', ''), ' ', ''), '-', '') = replace(replace(replace(replace(clean_val, '+91', ''), '+', ''), ' ', ''), '-', ''))
  );
END;
$$;
