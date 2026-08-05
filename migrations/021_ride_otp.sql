-- Migration: 021_ride_otp.sql
-- Description: Phase 1 — Ride OTP (Safety-Critical). Adds ride_otp column 
-- to verify passenger pickup and otp_attempts to prevent brute force.

ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS ride_otp TEXT,
  ADD COLUMN IF NOT EXISTS otp_attempts INT DEFAULT 0;
