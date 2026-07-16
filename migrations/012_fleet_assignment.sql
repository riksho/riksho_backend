-- Migration 012: Fleet Assignment
-- Adds assigned_driver_id to scheduled_jobs to allow pre-assigning drivers to scheduled fleet jobs.

ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS assigned_driver_id UUID REFERENCES drivers(id);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_assigned_driver ON scheduled_jobs(assigned_driver_id);

-- Expose to drivers via RLS
DROP POLICY IF EXISTS "Drivers can view their assigned jobs" ON scheduled_jobs;
CREATE POLICY "Drivers can view their assigned jobs" 
    ON scheduled_jobs FOR SELECT
    USING (auth.uid() = assigned_driver_id);
