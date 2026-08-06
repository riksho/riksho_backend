-- ============================================================
-- Migration: 027_documents_bucket_and_doctypes.sql
-- Fixes three defects in the driver-documents flow:
--   1. The `documents` storage bucket every client reads/writes was never created
--      (009 only created `driver-docs`), so all uploads failed.
--   2. `driver_documents.doc_type` rejected 4 of the 7 types the driver app offers
--      (id_front, id_back, license_front, license_back).
--   3. No storage RLS policies existed for the `documents` bucket.
--
-- Idempotent: migrate.ts re-runs every .sql file on each invocation.
-- ============================================================

-- 1. Create the bucket the code actually targets.
--    Kept PRIVATE: these are licenses, ID proofs and selfies. Reads go through
--    signed URLs minted server-side with the service_role key.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('documents', 'documents', false)
  ON CONFLICT (id) DO NOTHING;

-- Ensure the bucket is private even if it was created by hand as public.
UPDATE storage.buckets SET public = false WHERE id = 'documents';

-- 2. Widen doc_type to cover every type the driver app can upload.
--    Discover the constraint by definition rather than name, and use pg_constraint
--    (contype='c') rather than information_schema.check_constraints, which also
--    surfaces NOT NULL pseudo-constraints matching a '%doc_type%' filter.
DO $$
DECLARE
    con_name TEXT;
BEGIN
    FOR con_name IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = 'driver_documents'
          AND n.nspname = 'public'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) ILIKE '%doc_type%'
    LOOP
        EXECUTE format('ALTER TABLE public.driver_documents DROP CONSTRAINT IF EXISTS %I;', con_name);
    END LOOP;
END
$$;

ALTER TABLE public.driver_documents ADD CONSTRAINT driver_documents_doc_type_check
  CHECK (doc_type IN (
    'license', 'license_front', 'license_back',
    'id_front', 'id_back',
    'rc', 'insurance', 'vehicle_photo', 'profile_photo'
  ));

-- 3. Storage RLS for the `documents` bucket.
--    Paths are `<driver_id>/<doc_type>_<timestamp>.jpg`, so folder[1] is the owner.
DROP POLICY IF EXISTS "Drivers can upload own documents" ON storage.objects;
CREATE POLICY "Drivers can upload own documents"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'documents' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Drivers can update own documents" ON storage.objects;
CREATE POLICY "Drivers can update own documents"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'documents' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Drivers can read own documents" ON storage.objects;
CREATE POLICY "Drivers can read own documents"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'documents' AND auth.uid()::text = (storage.foldername(name))[1]);
