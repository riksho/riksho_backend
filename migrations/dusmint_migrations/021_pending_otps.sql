-- =============================================================================
-- 021_pending_otps.sql
-- Stores self-managed OTP codes for DusMint (bypasses Supabase signInWithOtp
-- so the SMS is routed via the 10MINT template instead of RIKSHO).
-- =============================================================================

CREATE TABLE IF NOT EXISTS dusmint_pending_otps (
  phone       TEXT PRIMARY KEY,                        -- e.g. +918010939887
  otp_code    TEXT NOT NULL,                           -- 6-digit code
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-cleanup: Supabase cron or manual prune rows older than 10 min
COMMENT ON TABLE dusmint_pending_otps IS
  'Temporary OTP storage for DusMint direct-SMS flow (10MINT sender ID). Rows auto-expire.';
