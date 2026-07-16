-- Migration 013: Proof of Delivery
-- Adds pod_path to rides table to store proof of delivery photo for Fleet and Quick jobs.

ALTER TABLE rides ADD COLUMN IF NOT EXISTS pod_path TEXT;

-- We could also create a bucket for PODs if not using a shared one
INSERT INTO storage.buckets (id, name, public) 
VALUES ('pods', 'pods', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for pods bucket
DROP POLICY IF EXISTS "Drivers can upload pods" ON storage.objects;
CREATE POLICY "Drivers can upload pods" 
ON storage.objects FOR INSERT 
WITH CHECK (bucket_id = 'pods' AND auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Anyone can view pods" ON storage.objects;
CREATE POLICY "Anyone can view pods" 
ON storage.objects FOR SELECT 
USING (bucket_id = 'pods');
