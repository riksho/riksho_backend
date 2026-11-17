-- =============================================================================
-- 022_vendor_address_and_onboarding.sql
-- Adds address column to vendors table for shop address storage
-- =============================================================================

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS address TEXT;
