-- 007_business_registration.sql
-- Extend businesses table for registration onboarding

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pan text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';

-- Allow business owners to update their own records
DROP POLICY IF EXISTS "Users can update their own businesses" ON businesses;
CREATE POLICY "Users can update their own businesses"
ON businesses FOR UPDATE
USING (auth.uid() = owner_user_id)
WITH CHECK (auth.uid() = owner_user_id);

-- Check if an email or phone belongs to an active registered business
CREATE OR REPLACE FUNCTION is_business_registered(lookup_value text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM businesses
    WHERE (email IS NOT NULL AND lower(trim(email)) = lower(trim(lookup_value)))
       OR (phone IS NOT NULL AND replace(replace(replace(phone, '+91', ''), ' ', ''), '-', '') = replace(replace(replace(trim(lookup_value), '+91', ''), ' ', ''), '-', ''))
  );
END;
$$;
