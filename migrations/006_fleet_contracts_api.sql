-- Phase 2: Fleet at Scale (B2B API & Contracts)

-- 1. API Keys (for programmatic access by businesses)
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  name text,
  is_active boolean DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 2. Contracts (Negotiated Rate Cards)
CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  vehicle_type text NOT NULL, -- e.g., 'mini_truck'
  base_fare numeric NOT NULL,
  per_km numeric NOT NULL,
  per_min numeric NOT NULL,
  minimum_fare numeric NOT NULL,
  valid_until timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(business_id, vehicle_type)
);

-- 3. Scheduled Jobs (Cron-like recurring or deferred single jobs)
CREATE TABLE scheduled_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  origin_lat numeric NOT NULL,
  origin_lng numeric NOT NULL,
  origin_address text NOT NULL,
  dest_lat numeric NOT NULL,
  dest_lng numeric NOT NULL,
  dest_address text NOT NULL,
  vehicle_type text NOT NULL,
  cargo_weight_kg integer NOT NULL,
  is_recurring boolean DEFAULT false,
  cron_expression text, -- e.g., '0 6 * * 1-5' (6 AM Mon-Fri)
  next_run_at timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 4. Webhook Endpoints
CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL, -- for HMAC signing
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 5. Invoices (Settlement)
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  total_amount numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft', -- draft, pending, paid
  created_at timestamptz DEFAULT now()
);

-- RLS (Restrict to API/Service Role and Admin)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated business owners (via businesses table join if needed)
-- For simplicity, since this is mostly accessed via API/Admin, we leave RLS strict 
-- and manage via backend service_role.

-- Also, add an idempotency_key to rides to prevent duplicate dispatch from ERP retries
ALTER TABLE rides ADD COLUMN IF NOT EXISTS idempotency_key text UNIQUE;
