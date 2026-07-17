-- Migration 014: Link a scheduled job to the ride it materialized into.
-- Enables idempotent "Start job" from the partner app (POST /fleet/jobs/:id/start)
-- and lets the scheduler avoid double-materializing a job a driver already started.

ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS ride_id UUID REFERENCES rides(id);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_ride ON scheduled_jobs(ride_id);
