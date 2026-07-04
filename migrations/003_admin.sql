-- 1. Ensure 'admin' role is permitted in users table
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('customer', 'driver', 'admin'));

-- 2. Create Admin action audit log
CREATE TABLE IF NOT EXISTS public.admin_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES auth.users(id),
  driver_id UUID REFERENCES public.drivers(id) ON DELETE SET NULL,
  action TEXT NOT NULL,          -- approved | rejected | suspended
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;

-- Only admins read this; all writes go through the service-role backend.
CREATE POLICY "Admins read admin_actions"
  ON public.admin_actions FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'));

CREATE INDEX IF NOT EXISTS idx_admin_actions_driver ON public.admin_actions(driver_id);

-- 3. Optional admin allow-list table
CREATE TABLE IF NOT EXISTS public.admin_allowlist (
  email TEXT PRIMARY KEY,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.admin_allowlist (email) VALUES ('shawsumit6286@gmail.com')
  ON CONFLICT (email) DO NOTHING;

-- 4. Seed the first admin user
-- NOTE: The user MUST already exist in auth.users (via Supabase dashboard / signup)
-- This query will upgrade their role to admin.
INSERT INTO public.users (id, email, role)
SELECT id, email, 'admin'
FROM auth.users
WHERE email = 'shawsumit6286@gmail.com'
ON CONFLICT (id) DO UPDATE SET role = 'admin', email = EXCLUDED.email;
