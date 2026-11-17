-- =============================================================================
-- 038_push_tokens_app_tag.sql
-- Add app column to push_tokens table to support multi-app targeting
-- (Riksho Customer, Riksho Buddy, DusMint Customer, DusMint Vendor)
-- =============================================================================

ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS app TEXT DEFAULT 'riksho';

COMMENT ON COLUMN public.push_tokens.app IS
  'Source application: riksho_rider, riksho_driver, dusmint_customer, dusmint_vendor';
