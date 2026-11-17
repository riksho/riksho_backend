-- =============================================================================
-- 001_extensions.sql
-- Enable required PostgreSQL extensions and core trigger functions for Dusmint
-- Run this FIRST in the Supabase SQL Editor
-- =============================================================================

-- PostGIS: geospatial queries for cluster lookup, address distance calculations
CREATE EXTENSION IF NOT EXISTS postgis;

-- UUID generation for primary keys
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Cryptographic functions for OTP hashing, seal QR generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Trigram index support for fuzzy text search (vernacular spelling tolerance)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Generic Trigger function to automatically update updated_at timestamp columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
