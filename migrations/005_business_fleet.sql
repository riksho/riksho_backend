-- 005_business_fleet.sql
-- Fleet MVP (Phase 1)

-- Create businesses table
CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  gstin text NOT NULL,
  address text NOT NULL,
  city text NOT NULL,
  tier text,
  created_at timestamptz DEFAULT now()
);

-- RLS for businesses
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own businesses"
ON businesses FOR SELECT
USING (auth.uid() = owner_user_id);

CREATE POLICY "Users can insert their own businesses"
ON businesses FOR INSERT
WITH CHECK (auth.uid() = owner_user_id);
