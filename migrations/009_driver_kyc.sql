-- ============================================================
-- Riksho — Phase 1: Driver KYC & Documents
-- Migration: 009_driver_kyc.sql
-- ============================================================

-- 1. Add onboarding_complete to drivers
ALTER TABLE public.drivers 
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false;

-- 2. Create driver_documents table
CREATE TABLE IF NOT EXISTS public.driver_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('license', 'rc', 'insurance', 'vehicle_photo', 'profile_photo')),
  storage_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (driver_id, doc_type)
);

-- 3. RLS for driver_documents
ALTER TABLE public.driver_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can view own documents"
  ON public.driver_documents FOR SELECT
  USING (auth.uid() = driver_id);

CREATE POLICY "Drivers can insert own documents"
  ON public.driver_documents FOR INSERT
  WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "Drivers can update own pending documents"
  ON public.driver_documents FOR UPDATE
  USING (auth.uid() = driver_id AND status = 'pending');

-- 4. Create storage bucket for driver-docs
-- Note: This requires the storage schema extensions, which Supabase has by default.
INSERT INTO storage.buckets (id, name, public) 
  VALUES ('driver-docs', 'driver-docs', false) 
  ON CONFLICT (id) DO NOTHING;

-- RLS for storage.objects in driver-docs
CREATE POLICY "Drivers can upload own docs"
  ON storage.objects FOR INSERT 
  WITH CHECK (bucket_id = 'driver-docs' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Drivers can read own docs"
  ON storage.objects FOR SELECT 
  USING (bucket_id = 'driver-docs' AND auth.uid()::text = (storage.foldername(name))[1]);
