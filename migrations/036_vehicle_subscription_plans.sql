-- Migration: 036_vehicle_subscription_plans.sql
-- Description: Multi-Vehicle Subscription Plans & Slashed Recharge Matrix for Riksho Drivers

-- 1. Extend subscription_plans schema
ALTER TABLE public.subscription_plans
ADD COLUMN IF NOT EXISTS vehicle_type TEXT NOT NULL DEFAULT 'all',
ADD COLUMN IF NOT EXISTS max_rides INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS is_milestone_plan BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS milestone_threshold NUMERIC(10,2) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS discount_label TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;

-- 2. Extend driver_subscriptions schema for vehicle and quota/milestone tracking
ALTER TABLE public.driver_subscriptions
ADD COLUMN IF NOT EXISTS vehicle_type TEXT DEFAULT 'all',
ADD COLUMN IF NOT EXISTS is_milestone_plan BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS milestone_threshold NUMERIC(10,2) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS max_rides INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS rides_used INT DEFAULT 0;

-- 3. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_subscription_plans_vehicle_active ON public.subscription_plans (vehicle_type, is_active, sort_order);

-- 4. Clean up old generic seed plans if needed
DELETE FROM public.subscription_plans WHERE id IN (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444'
);

-- 5. Insert New Vehicle-Specific Plans
INSERT INTO public.subscription_plans (
  id, name, vehicle_type, duration_hours, original_price, price, badge, discount_label, description, max_rides, is_milestone_plan, milestone_threshold, is_active, sort_order
) VALUES
  -- 🛺 Auto-Rickshaw Plans
  ('10000000-0000-0000-0000-000000000001', 'Auto 24h Daily Pass', 'auto', 24, 2000, 1500, 'popular', '25% OFF', '40% cheaper than Namma Yatri (₹25/day)', NULL, FALSE, NULL, TRUE, 1),
  ('10000000-0000-0000-0000-000000000002', 'Auto 7-Day Weekly Pass', 'auto', 168, 14000, 7900, 'best_value', '44% OFF', '~₹11.28/day (Saves ₹26 vs 7 daily passes)', NULL, FALSE, NULL, TRUE, 2),
  ('10000000-0000-0000-0000-000000000003', 'Auto 3-Day Saver Pack', 'auto', 72, 3500, 2000, 'saver_pack', '43% OFF', 'Ideal for part-time / morning shift autos (12 rides)', 12, FALSE, NULL, TRUE, 3),

  -- ⚡ Toto / E-Rickshaw Plans
  ('20000000-0000-0000-0000-000000000001', 'Toto 24h Daily Pass', 'e_rickshaw', 24, 1500, 1000, 'popular', '33% OFF', 'Most affordable daily pass for green drivers', NULL, FALSE, NULL, TRUE, 1),
  ('20000000-0000-0000-0000-000000000002', 'Toto 7-Day Weekly Pass', 'e_rickshaw', 168, 8000, 4500, 'best_value', '44% OFF', '~₹6.42/day unlimited hyperlocal earnings', NULL, FALSE, NULL, TRUE, 2),
  ('20000000-0000-0000-0000-000000000003', 'Toto 3-Day Saver Pack', 'e_rickshaw', 72, 3000, 1500, 'saver_pack', '50% OFF', '₹1 per trip flat — maximum flexibility (15 rides)', 15, FALSE, NULL, TRUE, 3),

  -- 🛵 Bike Taxi Plans
  ('30000000-0000-0000-0000-000000000001', 'Bike 24h Daily Pass', 'bike', 24, 1500, 1000, 'popular', '33% OFF', 'Half price of Rapido Captain (₹20/day)', NULL, FALSE, NULL, TRUE, 1),
  ('30000000-0000-0000-0000-000000000002', 'Bike 7-Day Weekly Pass', 'bike', 168, 9000, 4900, 'best_value', '46% OFF', '~₹7.00/day unlimited rides', NULL, FALSE, NULL, TRUE, 2),
  ('30000000-0000-0000-0000-000000000003', 'Bike 10 Rides Lite Pack', 'bike', 72, 2500, 1900, 'saver_pack', '24% OFF', 'Perfect for student / gig riders (10 rides)', 10, FALSE, NULL, TRUE, 3),
  ('30000000-0000-0000-0000-000000000004', 'Bike 30 Rides Power Pack', 'bike', 120, 3500, 2500, 'power_pack', '28% OFF', 'Peak rush-hour warriors (30 rides)', 30, FALSE, NULL, TRUE, 4),

  -- 🚕 Cab / Car Plans
  ('40000000-0000-0000-0000-000000000001', 'Cab Monthly Milestone Pass', 'cab', 720, 50000, 44900, 'best_value', '100% FREE UPFRONT', 'Free access until ₹12,000 earned, then ₹449 flat SaaS pass', NULL, TRUE, 12000.00, TRUE, 1),
  ('40000000-0000-0000-0000-000000000002', 'Cab 7-Day Weekly Flex', 'cab', 168, 15000, 11900, 'weekly_flex', '21% OFF', 'Flexible weekly pass without monthly lock-in', NULL, FALSE, NULL, TRUE, 2),
  ('40000000-0000-0000-0000-000000000003', 'Cab 24h Daily Flex Pass', 'cab', 24, 2500, 1900, 'daily_flex', '24% OFF', 'For occasional weekend cab drivers', NULL, FALSE, NULL, TRUE, 3),

  -- 🚚 Cargo / Delivery Plans
  ('50000000-0000-0000-0000-000000000001', 'Cargo 24h Daily Pass', 'cargo', 24, 2500, 1500, 'popular', '40% OFF', 'Unlimited intra-city deliveries for 24 hours', NULL, FALSE, NULL, TRUE, 1),
  ('50000000-0000-0000-0000-000000000002', 'Cargo 7-Day Weekly Pass', 'cargo', 168, 15000, 8900, 'best_value', '41% OFF', 'High-volume commercial deliveries pass', NULL, FALSE, NULL, TRUE, 2),
  ('50000000-0000-0000-0000-000000000003', 'Cargo 15 Trips Saver Pack', 'cargo', 72, 4000, 2500, 'saver_pack', '38% OFF', 'On-demand freight hauling saver pack (15 trips)', 15, FALSE, NULL, TRUE, 3)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  vehicle_type = EXCLUDED.vehicle_type,
  duration_hours = EXCLUDED.duration_hours,
  original_price = EXCLUDED.original_price,
  price = EXCLUDED.price,
  badge = EXCLUDED.badge,
  discount_label = EXCLUDED.discount_label,
  description = EXCLUDED.description,
  max_rides = EXCLUDED.max_rides,
  is_milestone_plan = EXCLUDED.is_milestone_plan,
  milestone_threshold = EXCLUDED.milestone_threshold,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
