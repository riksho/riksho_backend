# Riksho Backend

> Shared backend for the AngaZap customer and driver (partner) apps. Built with **Fastify + TypeScript**, powered by **Supabase** (Postgres + Auth + Realtime).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
# .env is already set up with your Supabase credentials

# 3. Run the initial database migration
# Copy migrations/001_initial_schema.sql → Supabase SQL Editor → Run

# 4. Start the dev server
npm run dev

# 5. Test health check
curl http://localhost:3001/health
```

## Project Structure

```
angazap_backend/
├── src/
│   ├── index.ts                  # Fastify server entry
│   ├── config/
│   │   ├── env.ts                # Typed env loader (Zod)
│   │   └── supabase.ts           # Service-role + anon clients
│   ├── common/
│   │   ├── auth.guard.ts         # JWT verification middleware
│   │   ├── errors.ts             # Standardized error classes
│   │   └── logger.ts             # Pino logger
│   ├── modules/
│   │   ├── auth/                 # GET /me, PUT /me
│   │   ├── drivers/              # Online/offline, location, earnings, registration
│   │   ├── rides/                # Full ride lifecycle (request → complete)
│   │   ├── fares/                # Fare engine + estimate endpoint
│   │   ├── matching/             # Nearby driver search + offer broadcast
│   │   ├── ratings/              # Customer ↔ Driver ratings
│   │   └── notifications/        # Push token registration
│   └── db/
│       └── migrate.ts            # Migration runner
├── migrations/
│   └── 001_initial_schema.sql    # Tables, RLS, indexes, seed data
├── .env                          # Server-only secrets
└── package.json
```

## API Endpoints

### Customer
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/me` | Get profile |
| PUT | `/me` | Update profile |
| POST | `/rides/estimate` | Get fare estimate |
| POST | `/rides` | Request a ride |
| GET | `/rides/:id` | Get ride details |
| GET | `/rides` | Ride history |
| POST | `/rides/:id/cancel` | Cancel ride |
| POST | `/ratings` | Submit rating |

### Driver
| Method | Path | Description |
|--------|------|-------------|
| POST | `/drivers/register` | Register as driver |
| GET | `/drivers/profile` | Get driver profile |
| POST | `/drivers/online` | Go online |
| POST | `/drivers/offline` | Go offline |
| POST | `/drivers/location` | Update location |
| POST | `/rides/:id/accept` | Accept ride (atomic) |
| POST | `/rides/:id/arrived` | Mark arrived |
| POST | `/rides/:id/start` | Start trip |
| POST | `/rides/:id/complete` | Complete trip |
| GET | `/drivers/earnings` | Earnings summary |

### Shared
| Method | Path | Description |
|--------|------|-------------|
| POST | `/push/register` | Register push token |

## Auth

All endpoints (except `/health`) require `Authorization: Bearer <supabase-jwt>`.

## Brand

- **Company:** AngaZap Technologies Pvt. Ltd.
- **Tagline:** One app for everything that moves
- **Description:** Cabs, bike taxis, intercity rides, and on-demand business fleets — fair fares, verified drivers, live tracking.
