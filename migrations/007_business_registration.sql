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
