-- ============================================================
-- Riksho — Initial Database Schema
-- Migration: 001_initial_schema.sql
-- Date: 2026-07-03
-- Description: Creates all core tables, indexes, and RLS policies
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. USERS (Customer profiles)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT,
  phone TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON public.users FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON public.users FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- 2. DRIVERS (Driver profiles)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.drivers (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  license_no TEXT,
  status TEXT DEFAULT 'offline' CHECK (status IN ('offline', 'online', 'on_trip')),
  rating NUMERIC(3,2) DEFAULT 5.00,
  total_trips INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can read own profile"
  ON public.drivers FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Drivers can update own profile"
  ON public.drivers FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Drivers can insert own profile"
  ON public.drivers FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ============================================================
-- 3. VEHICLES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vehicles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('bike', 'auto', 'car')),
  plate TEXT,
  model TEXT,
  seats INT DEFAULT 4,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can manage own vehicles"
  ON public.vehicles FOR ALL
  USING (auth.uid() = driver_id);

-- ============================================================
-- 4. DRIVER LOCATIONS (last known position for matching)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.driver_locations (
  driver_id UUID PRIMARY KEY REFERENCES public.drivers(id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.driver_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can manage own location"
  ON public.driver_locations FOR ALL
  USING (auth.uid() = driver_id);

-- Allow service role and authenticated users to read locations (for matching)
CREATE POLICY "Authenticated users can read driver locations"
  ON public.driver_locations FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================================
-- 5. RIDES (Full ride lifecycle)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.rides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES auth.users(id),
  driver_id UUID REFERENCES public.drivers(id),
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'accepted', 'arriving', 'in_progress', 'completed', 'cancelled')),
  vehicle_type TEXT CHECK (vehicle_type IN ('bike', 'auto', 'car')),
  origin_lat DOUBLE PRECISION,
  origin_lng DOUBLE PRECISION,
  origin_address TEXT,
  dest_lat DOUBLE PRECISION,
  dest_lng DOUBLE PRECISION,
  dest_address TEXT,
  distance_m INT,
  duration_s INT,
  fare_estimate NUMERIC(10,2),
  fare_final NUMERIC(10,2),
  payment_method TEXT DEFAULT 'cash',
  payment_status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT
);

ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;

-- Customers see their own rides
CREATE POLICY "Customers can read own rides"
  ON public.rides FOR SELECT
  USING (auth.uid() = customer_id);

-- Drivers see their assigned rides
CREATE POLICY "Drivers can read assigned rides"
  ON public.rides FOR SELECT
  USING (auth.uid() = driver_id);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_rides_customer ON public.rides(customer_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON public.rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON public.rides(status);

-- ============================================================
-- 6. RIDE EVENTS (Audit log for state transitions)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ride_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ride_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ride participants can read events"
  ON public.ride_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.rides
      WHERE rides.id = ride_events.ride_id
      AND (rides.customer_id = auth.uid() OR rides.driver_id = auth.uid())
    )
  );

CREATE INDEX IF NOT EXISTS idx_ride_events_ride ON public.ride_events(ride_id);

-- ============================================================
-- 7. RATINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  by TEXT NOT NULL CHECK (by IN ('customer', 'driver')),
  stars INT NOT NULL CHECK (stars >= 1 AND stars <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ride participants can read ratings"
  ON public.ratings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.rides
      WHERE rides.id = ratings.ride_id
      AND (rides.customer_id = auth.uid() OR rides.driver_id = auth.uid())
    )
  );

CREATE POLICY "Ride participants can insert ratings"
  ON public.ratings FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.rides
      WHERE rides.id = ride_id
      AND (rides.customer_id = auth.uid() OR rides.driver_id = auth.uid())
      AND rides.status = 'completed'
    )
  );

-- ============================================================
-- 8. PUSH TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.push_tokens (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own push tokens"
  ON public.push_tokens FOR ALL
  USING (auth.uid() = user_id);

-- ============================================================
-- 9. FARE CONFIG (per vehicle type pricing)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.fare_config (
  vehicle_type TEXT PRIMARY KEY CHECK (vehicle_type IN ('bike', 'auto', 'car')),
  base_fare NUMERIC(10,2) NOT NULL,
  per_km NUMERIC(10,2) NOT NULL,
  per_min NUMERIC(10,2) NOT NULL,
  minimum_fare NUMERIC(10,2) NOT NULL,
  surge_multiplier NUMERIC(4,2) DEFAULT 1.00
);

ALTER TABLE public.fare_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read fare config"
  ON public.fare_config FOR SELECT
  USING (true);

-- Seed default fare config
INSERT INTO public.fare_config (vehicle_type, base_fare, per_km, per_min, minimum_fare) VALUES
  ('bike', 20, 8, 1, 30),
  ('auto', 30, 12, 1.5, 50),
  ('car', 50, 15, 2, 80)
ON CONFLICT (vehicle_type) DO NOTHING;

-- ============================================================
-- Done!
-- ============================================================
