-- ============================================================
-- Riksho — Phase 2: Ride Timestamps
-- Migration: 010_ride_timestamps.sql
-- ============================================================

ALTER TABLE public.rides 
  ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
