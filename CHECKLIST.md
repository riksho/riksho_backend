# AngaZap Backend — Build Checklist

> Living document tracking everything that has been built, configured, and verified.

## ✅ Completed

### Phase 0: Setup & Configuration
- [x] Read existing `angazap_android/.env` and `app.json` — audited Clerk/Neon setup
- [x] Created `angazap_backend/` project skeleton
- [x] Created `.env` with all Supabase credentials (anon key, service role key, publishable key, secret key)
- [x] Created `package.json` with Fastify, Supabase JS, Zod, Pino, TypeScript
- [x] Created `tsconfig.json` (ES2022, NodeNext module resolution)
- [x] Created `.gitignore`
- [x] Installing dependencies (`npm install`)

### Phase 1: Core Infrastructure
- [x] `src/config/env.ts` — Zod-validated typed env loader
- [x] `src/config/supabase.ts` — Service-role + anon Supabase clients
- [x] `src/common/auth.guard.ts` — JWT verification middleware
- [x] `src/common/errors.ts` — AppError, NotFoundError, ConflictError, etc.
- [x] `src/common/logger.ts` — Pino logger with pretty dev output
- [x] `src/index.ts` — Fastify server with CORS, Helmet, error handler, health check

### Phase 2: Database Schema & Migrations
- [x] `migrations/001_initial_schema.sql` — 9 tables with RLS + indexes + seed data:
  - `users` — Customer profiles
  - `drivers` — Driver profiles with status
  - `vehicles` — Driver vehicles (bike/auto/car)
  - `driver_locations` — Last known lat/lng for matching
  - `rides` — Full ride lifecycle with state machine
  - `ride_events` — Audit log for every state transition
  - `ratings` — Customer ↔ Driver ratings
  - `push_tokens` — Expo push tokens
  - `fare_config` — Per vehicle-type pricing (seeded with defaults)
- [x] `src/db/migrate.ts` — Migration runner script

### Phase 3: API Modules
- [x] `modules/auth/auth.routes.ts` — GET /me, PUT /me
- [x] `modules/drivers/drivers.routes.ts` — online/offline, location, earnings, profile, register
- [x] `modules/rides/rides.routes.ts` — Full ride state machine (request → accept → arrived → start → complete → cancel)
- [x] `modules/fares/fares.config.ts` — Fare engine (base + per_km + per_min + surge + minimum)
- [x] `modules/fares/fares.routes.ts` — POST /rides/estimate (uses OSRM for distance)
- [x] `modules/matching/matching.service.ts` — Bounding-box nearby driver search + Realtime broadcast
- [x] `modules/ratings/ratings.routes.ts` — POST /ratings with avg rating update
- [x] `modules/notifications/push.routes.ts` — POST /push/register

### Phase 4: App Updates
- [x] Updated `angazap_android/app.json` — name: AngaZap, slug: angazap, scheme: angazap, colors: #4338CA, packages: com.angazap.customer
- [x] Updated `angazap_android/.env` — replaced Clerk with Supabase, removed secrets (moved to backend)

### Phase 5: Documentation
- [x] Created `README.md` with setup instructions + full API reference
- [x] Created `CHECKLIST.md` (this file)

## ⏳ Pending

### Database Deployment
- [ ] Run `migrations/001_initial_schema.sql` in Supabase SQL Editor
- [ ] Verify all tables created with `SELECT * FROM information_schema.tables WHERE table_schema = 'public'`
- [ ] Configure SMS provider (Twilio/MessageBird) in Supabase Auth for phone OTP

### Build Verification
- [ ] `npm run build` passes TypeScript compilation
- [ ] `npm run dev` starts server, `/health` returns 200

### Future Work
- [x] Create `angazap_partner_android/` (driver app) — Copied customer app skeleton and updated config
- [ ] Wire customer app auth to Supabase (replace Clerk)
- [ ] Wire customer app API calls to backend
- [ ] Build out driver app screens (earnings, map, online toggle)
- [ ] Stripe integration for online payments
- [ ] Expo push notification sender service
