-- Migration: 033_promo_code_soft_delete.sql
-- Adds is_deleted and deleted_at to driver_promo_codes for safe promo discontinuation

ALTER TABLE public.driver_promo_codes
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_driver_promo_codes_active_not_deleted
ON public.driver_promo_codes (is_active, is_deleted);
