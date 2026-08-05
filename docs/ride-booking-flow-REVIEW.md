# Review of `ride-booking-flow.md` — Corrections Before You Code

> Read this **alongside** `ride-booking-flow.md`. The plan's phase structure, ordering, and verification-gate discipline are good — keep them. This document fixes the parts that are factually wrong about the current codebase, and adds the blockers the plan doesn't know about.
>
> **Verdict:** Do not start Phase 1 as written. Fix the four blockers in **Phase 0** below first, then follow the original plan with the corrections in Part B.

---

## Part A — Blockers (these break the flow regardless of what you build)

These are live bugs in the exact path the plan describes. Three of them mean **the driver notification the plan is built around does not reliably fire today**. Building Phases 1–6 on top of these would produce a flow that works on your desk and fails in the field.

### 🔴 A1. Push notifications to drivers are silently broken (token type collision)

This is the most important finding, and it sits directly on the feature you care about most: the driver's popup.

Both apps register a push token at startup, but the **driver app registers twice, to two different systems, into a single-row-per-user table**:

| File | Function | Endpoint | Token kind |
|------|----------|----------|-----------|
| `riksho_partner_android/app/index.tsx:17` | `registerForPushNotificationsAsync()` (`lib/push.ts`) | `POST /push/register` | **Expo** token |
| `riksho_partner_android/app/_layout.tsx:51` | `registerPushToken()` (`lib/firebase.ts`) | `POST /push/fcm-register` | **FCM** token |

`push_tokens` has `user_id` as **PRIMARY KEY** (`migrations/016_push_notifications.sql`), and both endpoints `upsert(..., { onConflict: "user_id" })`. So the two registrations **overwrite each other** — last writer wins, non-deterministically, on every app launch.

Now the payoff. `sendPush()` — the function `matching.service.ts:110` uses to notify drivers of a new ride — posts to **`https://exp.host/--/api/v2/push/send`** (`push.service.ts:40`) and does **not filter on `token_type`**. When the FCM registration wins the race, `sendPush` hands a raw FCM token to Expo's API, which rejects it. The offer push is dropped, and the code logs nothing useful because delivery receipts are never checked (`push.service.ts:58`).

**Consequence for this plan:** the plan's Architecture table lists "Push Notifications | Expo Push API | ✅". That is only half-true, and the half that's broken is the driver-offer path. The plan then treats realtime as primary and push as "the backstop" (a comment in `home.tsx:184` says exactly this). **Today there is effectively no backstop.** A driver whose app is backgrounded — the normal case for a driver waiting for work — may receive nothing at all.

**Fix — pick ONE transport. Recommendation: FCM only.**

Reasons: both apps already have `@react-native-firebase/messaging`, `google-services.json`, and the Expo config plugins wired (`riksho_partner_android/app.json`); `fcm.service.ts` already implements `sendToTokens` via `sendEachForMulticast`; and FCM gives you `android.priority: "high"` + a dedicated channel, which is what actually wakes a backgrounded device for a time-critical offer. Expo Push adds a hop through Expo's servers for no benefit here.

1. Delete `riksho_partner_android/lib/push.ts` and its call in `app/index.tsx`. Do the same for any Expo-token path in the customer app.
2. Retire `POST /push/register` (`push.routes.ts`) — or make it a 410. Keep `/push/fcm-register` as the only registration route.
3. Rewrite `sendPush()` in `push.service.ts` to select `token, token_type`, filter `token_type = 'fcm'`, and delegate to `sendToTokens()` from `fcm.service.ts`.
4. Allow multiple devices per user: drop the `user_id` PK in favour of `PRIMARY KEY (user_id, token)`. A driver with a phone and a tablet is normal, and the current schema silently supports only one.

```sql
-- migrations/018_push_tokens_multidevice.sql
ALTER TABLE public.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_pkey;
ALTER TABLE public.push_tokens ADD PRIMARY KEY (user_id, token);
DELETE FROM public.push_tokens WHERE token_type IS DISTINCT FROM 'fcm';
```
> Note the `DELETE`: existing rows are a mix of Expo and FCM tokens with no way to tell which is which for older rows. Clearing non-FCM rows forces a clean re-register on next launch. Change `onConflict` to `"user_id,token"` in `/push/fcm-register` at the same time, or the upsert will error against the new key.

**A data-only notification is required, not a display notification.** For the offer to render as your custom in-app `OfferCard` with a countdown, the driver app must handle the message itself. Send FCM **without** a `notification` block for offers (data-only, `priority: high`) so `messaging().onMessage` / `setBackgroundMessageHandler` receive it. If you include a `notification` block, Android's system tray renders it while the app is backgrounded and your handler won't run.

**Also note:** the driver app has **no** `setBackgroundMessageHandler` registered anywhere (only `messaging().onMessage`, `_layout.tsx:54`, which is foreground-only). Add it in `index.js`/entry scope, outside the React tree. And the driver app does **not** depend on `notifee` (verified: 0 hits in `package.json`), so a full-screen heads-up offer alert needs it added — plain FCM cannot produce a full-screen intent.

---

### 🔴 A2. `POST /rides` will fail outright for `e_rickshaw` — a vehicle the customer app sells

The customer app's find-ride screen offers **bike, auto, e_rickshaw, car** and `RideRequestSchema` accepts seven types including `tempo`/`mini_truck`/`truck`. But the database still enforces the original constraint from day one:

```sql
-- migrations/001_initial_schema.sql:116  — never altered, verified across all 17 migrations
vehicle_type TEXT CHECK (vehicle_type IN ('bike', 'auto', 'car'))
```

I checked every migration for a `DROP CONSTRAINT` on this: `003` and `008` drop `users_role_check` and `check_job_ownership`, and nothing touches `rides_vehicle_type_check`. So **any ride requested as `e_rickshaw`, `tempo`, `mini_truck`, or `truck` is rejected by Postgres**, and `rides.routes.ts:61` turns that into a generic `500 "Failed to create ride"`. The customer sees "Could not request ride."

This is not hypothetical — `e_rickshaw` is displayed with an "ECO" badge in `find-ride.tsx:306` and is a first-class option in the UI you're about to build a booking flow on top of.

```sql
-- migrations/019_widen_vehicle_type.sql
ALTER TABLE public.rides DROP CONSTRAINT IF EXISTS rides_vehicle_type_check;
ALTER TABLE public.rides ADD CONSTRAINT rides_vehicle_type_check
  CHECK (vehicle_type IN ('bike','auto','e_rickshaw','car','tempo','mini_truck','truck'));

-- fare_config has the same stale constraint (001:234)
ALTER TABLE public.fare_config DROP CONSTRAINT IF EXISTS fare_config_vehicle_type_check;
ALTER TABLE public.fare_config ADD CONSTRAINT fare_config_vehicle_type_check
  CHECK (vehicle_type IN ('bike','auto','e_rickshaw','car','tempo','mini_truck','truck'));
```
> Confirm your actual constraint names first — `\d public.rides` in psql, or query `information_schema.table_constraints`. Auto-generated names usually follow `<table>_<column>_check` but verify rather than assume.

**Verification:** request one ride of each of the four customer-facing types and confirm all four reach `requested`. Do this **before** Phase 1; otherwise you'll be debugging OTP code when the real fault is a CHECK constraint.

---

### 🔴 A3. The customer's chosen fare is silently discarded

`find-ride.tsx` has a whole fare-stepper UI (`adjustFare`, ±₹5/₹10/₹20 per vehicle class, "Recommended fare") and sends the result:

```ts
// find-ride.tsx:155
body: JSON.stringify({ ..., offered_fare: adjustedFare })
```

`offered_fare` appears **nowhere** in the backend or the schema — I grepped all of `src/` and `migrations/`: zero hits. `RideRequestSchema` doesn't declare it, so Zod strips it; the ride is created with the server's `fare_estimate`; and the offer broadcast to drivers carries `fare_estimate`, not what the customer offered.

So a customer who raises their fare to ₹120 to attract a driver in the rain has that intent thrown away, and the driver's `OfferCard` shows the base ₹85. In a bid-based Indian ride market this is the difference between getting matched and not.

**Decide explicitly, and write the decision down:**

- **(a) Honour it (recommended — the UI already promises it).** Add `offered_fare` to the schema and an `offered_fare NUMERIC(10,2)` column. Clamp server-side to a sane band around `fare_estimate` (e.g. 0.8×–2.0×) so the field can't be abused, broadcast it to drivers as the headline number, and settle `fare_final` against it at completion.
- **(b) Remove the stepper** from `find-ride.tsx` so the UI stops promising something the system ignores.

Either is defensible; shipping the current mismatch is not. Note this interacts with `/complete`, which clamps `fare_final` to ±20% of `fare_estimate` (`rides.routes.ts:363`) — if you adopt offered-fare, that clamp must be relative to `offered_fare` instead, or you'll reject the fare the customer agreed to.

---

### 🔴 A4. Driver location goes stale during pickup → offers stop / matching lies

`findNearbyDrivers` only considers drivers whose `driver_locations.updated_at` is within 2 minutes (`matching.service.ts:35`), which is correct. But look at where location actually gets streamed:

- Home screen (`home.tsx:93`): streams every **10s**, and **only while `isOnline`** — the effect's dependency and early return are both on `isOnline`.
- Active trip (`ride/[rideId].tsx:60`): streams every **4s**, but **only** while status is `accepted`/`arriving`/`in_progress`, and **only while that screen is mounted and foregrounded**.

Both are plain `setInterval` in React components. When Android backgrounds the driver app — screen off, driver pocketing the phone while walking to the car, another app in front — **the interval stops firing**. There is no foreground service and no `expo-task-manager` background task in the driver app at all. (Ironically, the *customer* app has `lib/location.ts` with a proper `TaskManager` background task — and its actual location-upload call is commented out, lines 28–36. The background-location infrastructure exists in the wrong app, dead.)

Consequences, both squarely in this plan's path:
- **Phase 3 (live driver location on the customer map) will visibly freeze** whenever the driver backgrounds the app — precisely when the customer is staring at the map wondering where the driver is.
- A driver sitting idle with the screen off drifts past the 2-minute staleness window and **stops receiving offers** while still showing `online`.

**Fix (do this as part of Phase 0 or the very start of Phase 3):** move driver location to a real background task in the driver app — `expo-location`'s `startLocationUpdatesAsync` with `foregroundService` (the pattern already written in the customer app's `lib/location.ts`, which you can lift). Android 14+ requires `FOREGROUND_SERVICE_LOCATION` permission and a `foregroundServiceType`; add `expo-task-manager` to the driver app (currently absent from its `package.json`) and declare `ACCESS_BACKGROUND_LOCATION`. Keep the cadence adaptive: ~5s on an active trip, ~15–30s while idle-online, to protect battery and your Supabase write volume.

---

## Part B — Corrections to the plan's specific phases

The plan is mostly accurate. These are the places where it's wrong about the code, or where following it literally causes a break.

### B1. Phase 5 says "`ratings.routes.ts` — **NEW**". It already exists and is already registered.

`src/modules/ratings/ratings.routes.ts` is fully implemented (85 lines) and registered at `src/index.ts:100`. It is **better than the plan's proposed snippet** in three ways: it upserts on `onConflict: "ride_id,by"` (so the plan's "verify no duplicate ratings" check passes by design), it calls the **correct** RPC name, and it has a manual-average fallback.

The plan's snippet calls `rpc("update_driver_rating", { p_driver_id, p_stars })`. **That function does not exist.** The real one is `recompute_driver_rating(p_driver_id)` — single argument, recomputes a true average from all rows (`migrations/002_improvements.sql:107`). Implementing the plan's version would silently no-op the rating update (`.rpc()` on a missing function returns an error the snippet never checks) *and* regress correctness, because incrementing by `p_stars` is a running-sum approach while the existing code averages properly.

> **Action for Phase 5: write no backend code.** Build the two summary screens and have them POST to the existing `/ratings`. Delete the "5.3 Backend Changes" section.
>
> Also correct the plan's verification step 4: it says check `rating_sum` and `rating_count`. `recompute_driver_rating` updates **`rating`** and **`rating_count`** — it never writes `rating_sum` (that column exists from `002:43` but nothing maintains it). Verify `drivers.rating` instead.

### B2. Phase 1's OTP delivery is fragile — don't pass it through a route param

The plan generates the OTP, returns it in the `POST /rides` response, and then passes it via URL: `router.push(\`/ride/${id}?otp=${data.ride_otp}\`)`. The plan's own risk table claims this "persists in the component state."

It doesn't survive the realistic cases: the customer force-closes the app and reopens (Android kills backgrounded RN apps aggressively), or navigates away, or `searching.tsx` does `router.replace` on the accept broadcast — the param is gone and **the customer can never show their OTP**. The trip is then unstartable. That's a stuck ride requiring support intervention, caused by a design choice made for convenience.

**Fix:** make the OTP retrievable from server state, scoped to the customer.
- In `GET /rides/:id`, return `ride_otp` **only** when `ride.customer_id === userId`. Strip it for the driver — the existing handler returns `select("*")` (`rides.routes.ts:125`), so **as soon as you add the column, the OTP leaks to the assigned driver on every fetch**. This is the single easiest way to defeat the entire feature, and the plan's risk table misses it because it only considers broadcasts, not `GET /rides/:id`. Replace the `*` with an explicit column list, or delete the key before replying when the caller is the driver.
- Have the customer's ride screen read the OTP from that response. Drop the query param entirely.

Two more hardening notes:
- **`Math.random()` is not a CSPRNG.** For a 4-digit safety code, use `crypto.randomInt(1000, 10000)` from `node:crypto`. Cheap to do right.
- **Rate-limit OTP attempts.** As written, a driver can brute-force 9,000 possibilities with unlimited POSTs. Add an `otp_attempts INT DEFAULT 0` column, increment on each failure, and reject past 5 — then require support or customer re-confirmation. The global 100 req/min limit (`index.ts:55`) is per-IP and far too loose to matter here.

Also: generate the OTP **in the initial `INSERT`**, not in a follow-up `UPDATE` as the plan shows. The plan's two-step version leaves a window where the ride exists with a `NULL` OTP, and it costs an extra round trip for nothing.

### B3. Phase 1 breaks the delivery flows — `/start` is used by more than cabs

The plan says: *"Change the existing `/start` endpoint so it returns a 400 error… This forces the driver app to use `/verify-otp`."*

Do **not** do this unconditionally. `/start` is the `arriving → in_progress` transition for **all three service types**. The driver app's `getAction()` (`ride/[rideId].tsx:195`) maps it to **"Picked Up Order"** for `quick` deliveries, where it means *the rider collected the order from the darkstore* — there is no passenger and no OTP. Blanket-400 on `/start` **bricks every quick-commerce and fleet job**, and the plan's Phase 1 verification (which only walks a cab ride) would never catch it.

**Fix:** gate on `service_type`. Require OTP only for `service_type = 'move'`; leave `/start` working as-is for `fleet` and `quick`. Generate `ride_otp` only for `move` rides for the same reason.

> While you're there: the `quick` completion path in the driver app is an `Alert` confirmation that the code itself flags as *"an honest confirmation, NOT a secure OTP"* with a `TODO` (`ride/[rideId].tsx:129-132`). Once `move` OTP works, that TODO is a small extension — but it's out of scope for Phase 1 and should not be conflated with it.

### B4. Phase 3's location relay is wrong in two concrete ways

The plan's snippet checks `if (driverStatus === "on_trip")` — but `POST /drivers/location` (`drivers.routes.ts:47`) never reads the driver's status. It upserts and returns. There is no `driverStatus` variable in scope; the snippet won't compile.

More importantly, it then calls:

```ts
broadcastRideStatus(activeRide.id, "driver_location", { lat, lng });
```

`broadcastRideStatus` sends `event: "status_change"` with `payload: { status, ...payload }` (`broadcast.service.ts:12-30`). So this arrives at the customer as a **`status_change` with `status: "driver_location"`**. Both customer screens branch on exactly that field:

- `ride/[rideId].tsx:44` does `setRide(prev => ({ ...prev, status: newStatus, ...payload }))` — **overwriting the real ride status with the string `"driver_location"`**. The status banner breaks, and the cancel button (gated on `["accepted","arriving"]`, line 162) vanishes mid-ride.
- `searching.tsx:21` listens on the same channel; a stray event there is at best noise.

**Fix:** add a dedicated `broadcastDriverLocation(rideId, lat, lng)` in `broadcast.service.ts` that emits a **distinct event name** (`event: "driver_location"`), and have the customer subscribe with a second `.on("broadcast", { event: "driver_location" }, …)` handler. Never route positions through `status_change`. Separately, in the customer's `status_change` handler, **whitelist** known statuses before merging into state, so a future stray event can't corrupt the ride object again.

Also reconsider the transport. Relaying every driver fix (every 4s, per active ride) through a **backend HTTP POST to Supabase's broadcast REST endpoint** puts your Fastify process in the hot path of the highest-frequency event in the system. Two better options:
- Have the **driver app** broadcast its position directly to the `ride:{id}` channel via the Realtime client (the driver is already authenticated; no backend hop). Backend still records to `driver_locations` for matching.
- Or use Postgres Changes on `driver_locations` and let the customer subscribe to the row — no broadcast plumbing at all.

Either removes ~15 backend requests/minute/ride. At 100 concurrent rides that's 1,500 req/min of pure relay through a server that's rate-limited to 100 req/min per IP.

### B5. Phase 4's arrival detection is client-only — fine, but say so, and beware the frozen interval

Client-side Haversine is the right call for a *prompt* (the plan correctly refuses to auto-complete). Two notes:

- The geofence check runs inside the same `setInterval` that **A4 shows dies in the background**. A driver who backgrounds the app on approach gets no prompt. This phase is therefore **blocked on A4**, not independent of it.
- `/complete` trusts the driver's tap with no server-side location check (`rides.routes.ts:343`). A driver can complete from anywhere and, via the `fare_final` clamp, bank up to 120% of the estimate without driving. Worth a server-side sanity check — compare last known `driver_locations` against `dest_lat/lng` and log (don't hard-block; GPS drift is real) an anomaly for review.

### B6. Phase 2 detail: the driver's `vehicles` join and the customer's `name`

- The plan's `select("name, phone, rating, vehicles(type, plate, model)")` then reads `driverInfo?.vehicles?.[0]?.type`. `vehicles` has a **unique** `driver_id` (`onConflict: "driver_id"` in `drivers.routes.ts:171`), so Supabase may return an object rather than an array depending on how it infers the relationship. Handle both: `const v = Array.isArray(d.vehicles) ? d.vehicles[0] : d.vehicles`.
- `public.users.name` is **nullable** and the phone-OTP signup flow doesn't guarantee it's set. The offer card and driver info card must fall back gracefully ("Customer", "Rider") rather than render `null`.
- The plan's Phase 2 verification says "tap Call → verify it dials the customer's phone." That already reads `ride?.customer_phone` (`ride/[rideId].tsx:286`) and currently always hits the "Contact unavailable" branch, because nothing populates it. Good catch by the plan — just note the fix is entirely in `GET /rides/:id`.

### B7. Missing from the plan entirely: no driver ever sees the offer if none are online, and there's no retry

`findNearbyDrivers` logs `"No nearby drivers found"` and **returns silently** (`matching.service.ts:48`). The ride sits in `requested`. The customer's `searching.tsx` spins for 60s and shows "No drivers available."

There is **no re-broadcast, no radius expansion, and no retry** anywhere. One shot, 5 km, 10 drivers, done. On a real network with sparse coverage this is the dominant failure mode of the whole feature — far more common than a wrong OTP.

Consider adding to Phase 6 (or its own phase):
- **Staged radius expansion:** broadcast at 3 km, then 5 km at t+15s, then 8 km at t+30s, to the drivers not already offered.
- **Re-offer on decline/timeout:** today, a decline is purely local — `handleDeclineRide` just clears the card (`home.tsx:247`) and tells the server nothing. The backend cannot know to try someone else. Add `POST /rides/:id/decline` recording the refusal, and exclude those drivers from the next wave.
- **Distance-ordered offers.** The bounding-box query returns rows in arbitrary order and `.limit(10)` truncates them, so you may offer to the 10 *arbitrary* nearest-ish drivers and skip the closest one. Sort by true distance before slicing. `migrations/002_improvements.sql:124-168` already contains a **commented-out PostGIS `nearby_drivers()` implementation** — enabling it (`CREATE EXTENSION postgis`, available on Supabase) fixes ordering and correctness in one step, and the bounding box's `cos(lat)` longitude correction stops being an approximation.

### B8. The plan's "Estimated Effort: ~9 hours" is optimistic

I'd treat that as the happy-path coding time with no debugging, on a codebase with zero automated tests (there is no test file anywhere in either app or the backend — `jest-expo` is configured but unused). Realistically: Phase 0 blockers alone are ~4–6 hours (the background-location work in A4 is fiddly on Android 14+ and needs real-device testing). Budget **2–3 days** including the two-emulator verification the plan rightly asks for. That's not a criticism of the plan's structure — just don't let the estimate drive a decision to skip Phase 0.

---

## Part C — What the plan gets right (keep all of this)

Genuinely good, and I'd change none of it:

- **Phase ordering.** OTP → info → location → arrival → summary → edge cases is the correct dependency order, and it front-loads the safety-critical piece.
- **Hard verification gates between phases.** The "do NOT proceed until verification passes" rule is exactly right for a flow with this much cross-app state.
- **The state machine diagram** matches the DB `CHECK` constraint (`001:115`) exactly — `requested → accepted → arriving → in_progress → completed`, with `cancelled` reachable from the first three. No new statuses needed, so no migration risk there.
- **Refusing to auto-complete on arrival** (Phase 4.2, step 4). Correct — an automatic completion is a fare dispute waiting to happen.
- **Correctly identifying the accept race as already-solved.** The atomic `UPDATE … WHERE status='requested' AND driver_id IS NULL` (`rides.routes.ts:229-240`) is genuinely sound, and the driver app already handles the 409 (`home.tsx:236`).
- **Correctly noting the driver already streams location** during a trip, so Phase 3 needs no driver-side change — subject to A4.
- **Never putting the OTP in the driver broadcast.** Right instinct; it just needs extending to `GET /rides/:id` (see B2).

---

## Revised Implementation Order

```
┌─────────────────────────────────────────────────────────┐
│ PHASE 0 — BLOCKERS  (new; do this first)                │
│                                                         │
│  A1  Unify push on FCM; multi-device push_tokens        │
│      + setBackgroundMessageHandler + data-only offers   │
│  A2  Widen rides.vehicle_type CHECK  (e_rickshaw fails) │
│  A3  Decide offered_fare: honour it, or remove stepper  │
│  A4  Driver background location (foreground service)    │
└────────────────────────┬────────────────────────────────┘
                         ▼
                    VERIFY 0  ← see below
                         │
   Phase 1 (OTP)  ── corrected per B2 + B3
                         │  · OTP from GET /rides/:id, not a route param
                         │  · strip OTP from the driver's response
                         │  · crypto.randomInt; cap attempts
                         │  · gate on service_type='move' (don't brick quick/fleet)
                         ▼
                    VERIFY 1
                         │
   Phase 2 (Rich info) ── per B6 (nullable name; vehicles shape)
                         ▼
                    VERIFY 2
                         │
   Phase 3 (Live location) ── per B4: NEW event name, not status_change
                         │            prefer client→Realtime over backend relay
                         ▼
                    VERIFY 3
                         │
   Phase 4 (Arrival) ── depends on A4; add server-side sanity check
                         ▼
                    VERIFY 4
                         │
   Phase 5 (Summary + rating) ── UI ONLY. /ratings already exists (B1)
                         ▼
                    VERIFY 5
                         │
   Phase 6 (Edge cases) + B7 (retry / radius expansion / decline)
                         ▼
                    VERIFY 6
```

### VERIFY 0 — run this before touching Phase 1

1. Fresh-install the driver app, log in, then query `push_tokens` for that `user_id`: exactly the expected row(s), all `token_type = 'fcm'`. Relaunch the app 3× — the row must **not** flip between token kinds.
2. Background the driver app (home button, screen off). Request a ride from the customer app. **The driver device must surface the offer.** This is the single most important check in the whole plan — it's the behaviour you asked for, and it does not work today.
3. Request one ride of **each** customer-facing vehicle type (bike, auto, e_rickshaw, car). All four must reach `status = 'requested'`. Before the fix, `e_rickshaw` returns 500.
4. Confirm your A3 decision is visible in the product: either the driver's offer card shows the customer's adjusted fare, or the stepper is gone from `find-ride.tsx`.
5. Driver online, app backgrounded, screen off, 5 minutes. Then check `driver_locations.updated_at` — it must be **fresh (< 2 min)**. Before the fix it will be ~5 minutes stale, and that driver is invisible to matching.
6. `npm run build` in `riksho_backend` passes (`tsc`). The plan's `CHECKLIST.md` still shows `npm run dev` + `/health` as unverified — close that too.

---

## One-line summary

The plan is a solid skeleton with the right instincts about safety, ordering, and verification gates — but it audits the codebase as "✅ Built" in several places where the code is present yet **non-functional**, and it doesn't know that **the driver notification it's built around is broken today** (A1), that **one of four vehicle types can't be booked at all** (A2), or that **`ratings` is already done** (B1). Fix Phase 0, apply the Part B corrections, then execute the original phases as written.

---
---

# IMPLEMENTATION LOG

> Append-only record of what was actually changed, why, and what you must verify by hand. One section per fix.

## Log 001 — A1 (push transport unified on FCM) + A2 (vehicle_type widened)

**Date:** 2026-08-05
**Status:** Code complete. **Migrations NOT yet applied** — see Step 1 of the manual checklist.
**Build state:** `riksho_backend` → `npm run build` passes. `riksho_partner_android` → `npx tsc --noEmit` clean except one **pre-existing** error in `app/(auth)/onboarding/index.tsx:477` (`Timeout` vs `number`) that I did not touch. `riksho_android` → one **pre-existing** error in `components/RideLayout.tsx:42` (`height: string`), also untouched.

### What changed — files

#### New files (3)

| File | Purpose |
|------|---------|
| `riksho_backend/migrations/018_widen_vehicle_type.sql` | **A2.** Drops the stale day-one `CHECK (vehicle_type IN ('bike','auto','car'))` on `rides` and `fare_config`, replaces it with all 7 types, and seeds the 4 missing `fare_config` rows. |
| `riksho_backend/migrations/019_push_tokens_multidevice.sql` | **A1.** Repoints `push_tokens` PK from `user_id` → `(user_id, token)`, purges all non-FCM tokens, enforces `token_type = 'fcm'`, enables RLS. |
| `riksho_partner_android/lib/pushHandlers.ts` | **A1.** FCM background + foreground message handlers, offer payload parsing, and Android notification-channel creation. |

#### Deleted files (1)

| File | Reason |
|------|--------|
| `riksho_partner_android/lib/push.ts` | The Expo-token registration path. This was the direct cause of A1 — it raced `lib/firebase.ts`'s FCM registration into the same single-row table. |

#### Modified files (7)

**Backend**

- **`src/modules/notifications/push.service.ts`** — rewritten.
  - `sendPush()` no longer posts to `https://exp.host/...`. It now selects tokens `WHERE token_type = 'fcm'` and delegates to `sendToTokens()`. **This is the actual A1 fix**: the old code handed FCM tokens to Expo's API, which rejected them, dropping every ride-offer push.
  - Added `sendRideOfferPush()` — sends **data-only** high-priority messages for offers.
  - Added `stringifyData()` — FCM requires all data values to be strings; numeric fields like `fare_estimate` would otherwise cause FCM to reject the whole send.
  - Invalid tokens returned by FCM are now pruned automatically.

- **`src/modules/notifications/fcm.service.ts`** — extended.
  - `sendToTokens()` now returns `MulticastResult { successCount, failureCount, invalidTokens }` instead of a bare `number`, and **no longer throws** (it returns an empty result), so a push failure can't take down a ride-state transition.
  - Added `sendDataMessage()` — data-only, `priority: high`, 60s TTL. No `notification` block, which is what lets the driver app render its own `OfferCard`.
  - Added `pruneInvalidTokens()` and `PERMANENT_TOKEN_ERRORS`. Only genuinely dead tokens are deleted; transient errors (quota, unavailable) are **not** pruned, so a Firebase outage can't wipe the token table.

- **`src/modules/matching/matching.service.ts`**
  - Swapped `sendPush` → `sendRideOfferPush`.
  - Extracted the duplicated offer payload into a single `offerPayload` object shared by both transports.
  - **Behaviour fix:** the per-driver `broadcastRideOffer` calls were `await`ed inside a `for` loop, so offering to 10 drivers cost 10 sequential round trips and the 10th driver saw the offer measurably later than the 1st — skewing who could win the race to accept. Now `Promise.allSettled`.

- **`src/modules/notifications/push.routes.ts`** — `POST /push/register` now returns **410 Gone** with a log line, instead of writing a token. Kept rather than deleted so an older installed build gets a clear signal instead of a 404 that looks like a routing bug.

- **`src/modules/notifications/fcm.routes.ts`** — `onConflict` changed `"user_id"` → `"user_id,token"` to match the new composite PK. **This change is mandatory and coupled to migration 019** — the old `onConflict` would error against the new key. Also added a cleanup delete: if a driver logs out and another account logs in on the same phone, the previous user's row for that device token is removed, so the old account's offers stop arriving on a device it no longer owns.

**Driver app**

- **`app/index.tsx`** — removed the `registerForPushNotificationsAsync()` import and its `useEffect`. Replaced with a comment explaining why registration must not happen here.
- **`app/_layout.tsx`** — registers `registerBackgroundMessageHandler()` at **module scope** (outside the component; Android runs it in a headless JS task with nothing mounted). Adds `ensureNotificationChannels()`, `listenForTokenRefresh()`, and swaps the inline `messaging().onMessage` for `registerForegroundMessageHandler()`. All three listeners are torn down on unmount. Also removed a **duplicate `"Jakarta-SemiBold"` key** in the `useFonts` map that was causing a TS error (pre-existing, one line, in a file I was already editing).
- **`store/index.ts`** — added `useRideOfferStore`.
- **`app/(root)/(tabs)/home.tsx)`** — offers now come from `useRideOfferStore` instead of local `useState`, so a push that arrives while this screen is unmounted isn't lost. `handleAcceptRide` captures `ride_id` into a local before awaiting (the old code read `currentOffer.ride_id` *after* clearing state, a latent race). Decline now calls `markHandled` so the push backstop can't re-pop a card the driver just dismissed.

### Two design decisions worth knowing

**1. Offers are data-only pushes; status updates stay visible pushes.**
A push containing a `notification` block is rendered by Android's system tray while the app is backgrounded, and **your JS never runs**. That would give the driver a dead notification with no Accept button and no countdown. So ride offers carry data only, and `lib/pushHandlers.ts` decides what to draw. The four customer-facing status pushes (`accepted`/`arriving`/`in_progress`/`completed`) keep their `notification` block — those *should* appear in the tray.

**2. Offers are deduped in the store, not in each listener.**
The same offer now arrives twice by design — Realtime (fast, foreground) and FCM (survives backgrounding). `useRideOfferStore.receiveOffer()` is the single dedupe point, keyed on `ride_id` with a rolling 50-entry `handledRideIds` list. Whichever transport lands first wins; the loser is dropped silently. Without this you'd get two stacked offer cards.

### 🐛 Bonus bug found and fixed while implementing A1

**Every visible push notification was being silently dropped on Android 8+.**

`fcm.service.ts` has always sent `android.notification.channelId: "riksho_general"`. I grepped both apps and both `AndroidManifest.xml` files: **that channel was never created anywhere.** On Android 8+ (API 26, i.e. essentially every device in service), a notification addressed to a nonexistent channel is discarded with no error and nothing in the tray.

So `"Driver Accepted"`, `"Driver Arrived"`, `"Trip Started"`, `"Trip Completed"` — all four customer-facing pushes in `rides.routes.ts` — were going nowhere. This is separate from A1 and would have survived the A1 fix untouched.

- **Driver app: FIXED.** `ensureNotificationChannels()` creates `riksho_general` with `AndroidImportance.HIGH` on startup.
- **Customer app: NOT FIXED — needs a dependency.** `riksho_android` does not have `expo-notifications` in its `package.json` (verified: 0 hits), so there's no API available to create the channel. This is a real gap: **the customer is the primary recipient of all four status pushes.** Deliberately left out of A1/A2 rather than adding a dependency and a native rebuild outside the agreed scope. See "Deferred" below.

### Deferred — not done, and why

| Item | Why deferred |
|------|--------------|
| Customer-app notification channel | Requires adding `expo-notifications` to `riksho_android` + a native rebuild. Scope creep beyond A1/A2. **Do this before Phase 2** — until then, customer status pushes remain invisible on Android 8+. Alternative with no new dependency: add `<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="riksho_general"/>` to the manifest, or drop `channelId` from the backend payload so FCM uses the default channel. |
| A3 (`offered_fare`) | Needs your product decision (honour it vs. remove the stepper). Documented in Part A. |
| A4 (background location) | Largest of the four. Needs `expo-task-manager` added to the driver app, `FOREGROUND_SERVICE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` permissions, and real-device testing. **Phase 3 and Phase 4 are blocked on this.** |
| `notifee` full-screen offer alert | Not installed. Current implementation shows the offer card when the app is opened; it cannot light up a locked screen. Consider before launch — a driver with a pocketed phone still needs the *sound*, which the HIGH-importance channel now provides. |

---

## ✋ Manual verification — do these in order

Steps 1–2 are **mandatory and blocking**. Nothing else works until the migrations are applied.

### Step 1 — Apply the two migrations ⚠️ BLOCKING

`npm run migrate` relies on an `exec_sql` RPC that may not exist in your project (the runner degrades to "paste it manually"). **Use the Supabase SQL Editor** to be certain:

1. Supabase Dashboard → SQL Editor → New Query.
2. Paste **all** of `migrations/018_widen_vehicle_type.sql` → Run. Expect `NOTICE: Dropped CHECK constraint on rides.vehicle_type: ...`.
3. Paste **all** of `migrations/019_push_tokens_multidevice.sql` → Run. Expect `NOTICE: Dropped single-column primary key: push_tokens_pkey` and `Added composite primary key (user_id, token)`.

Both are idempotent — re-running is safe.

> **Expected and intentional:** migration 019 **deletes every existing push token.** Every user stops receiving pushes until they next open the app, which re-registers within a second. The old rows were an indistinguishable mix of Expo and FCM tokens; keeping them would preserve the bug.

Confirm:

```sql
-- expect all 7 vehicle types
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'rides_vehicle_type_check';

-- expect: PRIMARY KEY (user_id, token)
SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'push_tokens' AND con.contype = 'p';

-- expect only 'fcm', or zero rows right after migrating
SELECT token_type, count(*) FROM public.push_tokens GROUP BY token_type;

-- expect 7 rows
SELECT vehicle_type FROM public.fare_config ORDER BY vehicle_type;
```

### Step 2 — Rebuild the driver app natively ⚠️ BLOCKING

`setBackgroundMessageHandler` and the notification channel are **not** hot-reloadable. A Metro refresh is not enough:

```bash
cd riksho_partner_android
npx expo run:android
```

Then **fully uninstall and reinstall** the driver app on your test device, so you get a fresh FCM token against the clean `push_tokens` table.

### Step 3 — Token hygiene (proves A1's root cause is gone)

1. Fresh-install driver app → log in.
2. `SELECT user_id, token_type, platform, updated_at FROM push_tokens WHERE user_id = '<driver-uuid>';`
   - ✅ Exactly **one** row, `token_type = 'fcm'`.
   - ❌ If you see two rows, or `token_type` is NULL/`expo`, the Expo path is still alive somewhere.
3. **Force-close and reopen the app 3 times.** Re-query after each.
   - ✅ Same single row, `updated_at` bumping.
   - ❌ **If the row's `token` flips between launches, A1 is not fixed.** That flip-flop was the entire bug.

### Step 4 — 🎯 The one that matters: backgrounded driver receives the offer

This is the behaviour you originally asked for, and the thing that did not work before.

1. Driver app → **GO ONLINE**. Confirm `driver_locations` has a fresh row.
2. **Press the device Home button.** Driver app fully backgrounded. Optionally turn the screen off.
3. From the customer app: request a ride near the driver.
4. ✅ **The driver device must react** — sound/vibration from the HIGH-importance channel.
5. Open the driver app → the **OfferCard must be showing**, with correct pickup/drop addresses, fare, and distance.
6. ✅ Accept it → navigates to the active trip, ride reaches `accepted`.

> **Caveat, stated honestly:** on a **cold start** (app killed by the OS, not just backgrounded), Android may run the headless task in a fresh JS context and the store write can be lost. In that case the offer still arrives via the realtime re-subscribe on foreground (`home.tsx` `AppState` handler) as long as the ride is still `requested`. If you need a guaranteed lock-screen popup, that needs `notifee` — see Deferred.

Check the backend log for `"Sent data-only ride offer push"` with `successCount` ≥ 1. If `successCount` is 0, the token is stale → redo Step 2.

### Step 5 — A2: all four vehicle types actually book

For **each** of bike, auto, **e_rickshaw**, car: pick it on find-ride → Find a Driver.

- ✅ All four reach `status = 'requested'`.
- Before this fix, **e_rickshaw returned a 500** ("Could not request ride") because of the stale CHECK constraint.

```sql
SELECT vehicle_type, status, created_at FROM rides ORDER BY created_at DESC LIMIT 4;
```

### Step 6 — No duplicate offer cards

With the driver app **in the foreground**, request a ride. Both transports now deliver the same offer within ~1s of each other.

- ✅ Exactly **one** OfferCard.
- ❌ Two stacked cards ⇒ the store dedupe isn't being hit; check that the realtime listener calls `receiveOffer` and not `setCurrentOffer`.

Then **Decline** an offer and immediately request another ride from the same customer:
- ✅ The declined ride does **not** re-pop; the new one does.

### Step 7 — Regression: the retired endpoint and multi-device

1. `curl -X POST http://localhost:3001/push/register -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"token":"x","platform":"android"}'`
   - ✅ **410** with `ENDPOINT_RETIRED`. (A `500` means migration 019 didn't apply; a `200` means an old build of the route is still deployed.)
2. If you have two devices: log the **same** driver into both. `SELECT count(*) FROM push_tokens WHERE user_id = '<uuid>';` → ✅ **2**. This was impossible before.
3. Log a **different** account into one of those devices. → ✅ the first account's row for that token is gone (no cross-account offer leakage).

### Step 8 — Regression: customer status pushes still flow

Run one full ride: accept → arrived → start → complete.

- ✅ Backend logs `"Sent push notifications via FCM"` at each transition, `successCount` ≥ 1.
- ⚠️ **The customer will likely still not SEE these in the tray** — that's the deferred channel gap, not an A1 regression. Verify via the backend log, not the device. Confirm the in-app realtime status transitions still work (`ride/[rideId].tsx` banner updates), since that path is independent of push.

### Step 9 — Close the CHECKLIST.md gap

`CHECKLIST.md` still lists `npm run dev` + `/health` as unverified:

```bash
cd riksho_backend && npm run dev
curl http://localhost:3001/health   # expect 200
```

---

### Rollback

If Step 4 or 5 fails and you need to get back to the previous state fast:

```sql
-- Revert 019 (back to single-token-per-user)
ALTER TABLE public.push_tokens DROP CONSTRAINT push_tokens_token_type_check;
ALTER TABLE public.push_tokens ALTER COLUMN token_type DROP NOT NULL;
DELETE FROM public.push_tokens a USING public.push_tokens b
  WHERE a.ctid < b.ctid AND a.user_id = b.user_id;   -- keep one row per user
ALTER TABLE public.push_tokens DROP CONSTRAINT push_tokens_pkey;
ALTER TABLE public.push_tokens ADD PRIMARY KEY (user_id);
```

`018` needs no rollback — widening a CHECK constraint cannot invalidate existing rows. Reverting it would only re-break e_rickshaw.

For the code, revert these three commits-worth of changes together: `push.service.ts` + `fcm.service.ts` + `fcm.routes.ts` are **mutually dependent** (the `onConflict` key, the `MulticastResult` return type, and the `token_type` filter). Reverting one alone will not compile.

---

## Log 002 — A3 (Offered Fare) + A4 (Driver Background Location)

**Date:** 2026-08-05
**Status:** Code complete. **Migrations NOT yet applied** — see Step 1 of the manual checklist.

### What changed — files

#### New files (2)

| File | Purpose |
|------|---------|
| `riksho_backend/migrations/020_offered_fare.sql` | **A3.** Adds `offered_fare` to track the customer's bid. |
| `riksho_partner_android/lib/backgroundLocation.ts` | **A4.** Implements a robust foreground service for location tracking using `expo-task-manager`, ensuring updates aren't paused when the app is backgrounded. |

#### Modified files (11)

**Backend**

- **`src/common/schemas.ts`** — **A3.** Added `offered_fare` to `RideRequestSchema`.
- **`src/modules/fares/fares.config.ts`** — **A3.** Defined bounding ratios (`OFFERED_FARE_MIN_RATIO`, `OFFERED_FARE_MAX_RATIO`) and helper functions `clampOfferedFare` and `effectiveFare` to ensure safe bounds around the baseline estimate and determine the "agreed fare".
- **`src/modules/rides/rides.routes.ts`** — **A3.** In `POST /rides`, `offered_fare` is clamped securely before saving, and the final value is echoed to the customer. For completion, the `fare_final` clamp is now relative to the `agreedFare` (the customer's accepted bid, when present).
- **`src/modules/matching/matching.service.ts`** — **A3.** Extracted the `offered_fare` into the payload and set `is_boosted` to correctly inform the driver if the bid was higher than standard.
- **`src/modules/matching/broadcast.service.ts`** — **A3.** Extended the broadcast interface with `fare_estimate`, `base_estimate`, and `is_boosted`.
- **`src/index.ts`** — **A4.** Updated rate-limiting to use `request.user?.id ?? request.ip` with a limit of 300, avoiding false 429s for drivers sharing mobile NAT IPs.

**Driver App**

- **`app.json`** — **A4.** Added necessary permissions (`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK`, `POST_NOTIFICATIONS`) and explicitly configured the `expo-location` plugin attributes.
- **`app/(root)/(tabs)/home.tsx`** — **A4.** Replaced the 10s interval string location updater with `startLocationTracking` and `stopLocationTracking` when transitioning `isOnline`.
- **`app/(root)/ride/[rideId].tsx`** — **A3/A4.** Updated to surface the `offered_fare` and dynamically adjusted location-fetching interval on-trip ("onTrip" cadence) versus returning to idle mode afterwards.
- **`components/OfferCard.tsx`** — **A3.** Styled `offer.is_boosted` condition to show a prominent "▲ BOOSTED" badge.
- **`lib/pushHandlers.ts`** — **A3.** Type-casted incoming payload strings into standard types.
- **`app/(root)/(tabs)/profile.tsx`** — **A4.** Ensures `stopLocationTracking` triggers safely prior to sign-out, removing ghost tracking when offline.

**Customer App**

- **`app/(root)/find-ride.tsx`** — **A3.** Shows an `Alert` informing the rider if their bid was clamped externally by the server backend logic.
- **`app/(root)/ride/[rideId].tsx`** — **A3.** Added the agreed `offered_fare` inline logic as a visual representation to the customer.

---

### ✋ Manual verification — do these in order

#### Step 1 — Apply Migrations and Install Packages ⚠️ BLOCKING
1. Add `020_offered_fare.sql` to Supabase via SQL editor or `npm run migrate`.
2. Do a fresh native build of the `riksho_partner_android` app (since native permissions and configurations in `app.json` were changed for A4 background tracking and `expo-task-manager` was installed).

#### Step 2 — Test Fare Adjustments (A3)
1. **Find a Driver (Customer App):** Enter locations and observe the fare estimate. Modify the fare with the stepper so it is 1.5x the base. Confirm ride.
2. **Offer Card (Driver App):** Ensure the notification arrives and clearly states "▲ BOOSTED" beside the bumped fare.
3. **Out-of-bounds Testing:** Attempt to bypass the stepper or intercept the network call and inject an absurdly high (e.g. ₹10,000) or low fare. Ensure the backend clamps it successfully and the customer app shows the adjustment Alert.

#### Step 3 — Background Location Cadence (A4)
1. Ensure the driver is "Online". Put the app in the background. Wait 3 minutes, then check if `updated_at` in `driver_locations` table is recent (A4 fixes stale locations).
2. Accept a ride, verify the backend logs receive location posts frequently (~5s intervals).
3. Log out on the driver app. Check if the location updates stop entirely, ensuring there are no lingering ghost posts.

---

## Log 003 — B1 (Rating Screens) + B2 (Phase 1 OTP Fixes)

**Date:** 2026-08-05
**Status:** Code complete. **Migrations NOT yet applied** — see Step 1 of the manual checklist.

### What changed — files

#### New files (3)

| File | Purpose |
|------|---------|
| `riksho_backend/migrations/021_ride_otp.sql` | **B2.** Adds `ride_otp` and `otp_attempts` columns to secure passenger pickups against brute force and unverified starts. |
| `riksho_android/app/(root)/ride-complete.tsx` | **B1.** Phase 5 Post-Ride Summary and Rating Screen for Customers. |
| `riksho_partner_android/app/(root)/ride-complete.tsx` | **B1.** Phase 5 Post-Ride Summary and Rating Screen for Drivers. |

#### Modified files (3)

**Backend**

- **`src/modules/rides/rides.routes.ts`** — **B2.**
  - `POST /rides`: Generates a secure OTP using `crypto.randomInt` for `move` rides.
  - `GET /rides/:id`: Strips `ride_otp` from the response if the caller is the driver, preventing leakage.
  - `POST /rides/:id/start`: Blocks standard start for `move` rides, requiring OTP verification.
  - `POST /rides/:id/verify-otp`: New route to accept OTP, check attempts (max 5), verify, and transition the ride to `in_progress`.

**Driver App**

- **`app/(root)/ride/[rideId].tsx`** — **B1 & B2.**
  - **B2:** Replaced the "Start Trip" button with an OTP input field and a "Verify OTP & Start" button when the status is `arriving` and the service type is `move`.
  - **B1:** Added routing to `/(root)/ride-complete` when the trip status transitions to `completed` instead of a static `Alert`.

**Customer App**

- **`app/(root)/ride/[rideId].tsx`** — **B1 & B2.**
  - **B2:** Conditionally renders a prominent OTP banner containing `ride.ride_otp` while the status is `arriving` to prompt the customer to share it with the driver.
  - **B1:** Replaced the completion Alert with a route push to `/(root)/ride-complete`.

---

### ✋ Manual verification — do these in order

#### Step 1 — Apply Migrations ⚠️ BLOCKING
1. Add `021_ride_otp.sql` to Supabase via SQL editor or `npm run migrate`.

#### Step 2 — Test OTP Safety (B2)
1. **Request & Accept Ride (Move Service):** Create a passenger ride (e.g., auto/car/bike/e_rickshaw).
2. **Driver Arrival:** Tap "I've Arrived" in the driver app.
3. **Verify App UI:**
   - The customer app must display the 4-digit OTP prominently in the status banner.
   - The driver app must switch the "Start Trip" button to an OTP text input field.
4. **Brute Force Defense:** Enter a wrong OTP 5 times. Ensure the driver is locked out with a 429 Too Many Attempts error.
5. **Success Path:** Enter the correct OTP and ensure the trip status transitions to `in_progress`.

#### Step 3 — Test Ratings & Summary Screens (B1)
1. Complete a ride from the driver's side.
2. Ensure both the Customer App and Driver App smoothly transition to the new `ride-complete` screens showing final fares.
3. Rate the driver/customer using the stars and click Submit.
4. Verify the database table `ratings` captures both scores correctly.

---

## Log 004 — B3 (Service-Type OTP Gating) + B4 (Location Broadcast Fixes)

**Date:** 2026-08-05
**Status:** Code complete. **Migrations NOT yet applied** — see Step 1 of the manual checklist.

### What changed — files

#### New files (1)

| File | Purpose |
|------|---------|
| `riksho_backend/migrations/022_driver_locations_realtime.sql` | **B4.** Enables Supabase Realtime (Postgres Changes) on the `driver_locations` table so the customer app can subscribe to driver movements directly without taxing the Fastify backend. |

#### Modified files (3)

**Backend**

- **`src/modules/rides/rides.routes.ts`** — **B3.**
  - `POST /rides/:id/start`: Added a check on `service_type`. Only blocks standard starts for `move` (passenger) rides, ensuring `quick` and `fleet` deliveries can still use `/start` without needing OTPs.

**Customer App**

- **`app/(root)/ride/[rideId].tsx`** — **B4.**
  - Fixed the `status_change` listener corruption issue by whitelisting valid states (e.g. `accepted`, `arriving`) before merging into the `status` state.
  - Implemented a dedicated `postgres_changes` realtime subscription to track the driver's live location straight from `driver_locations` instead of relying on overloaded `status_change` events.
  - Passes the new `driverLocation` state down through `RideLayout`.
- **`components/Map.tsx` & `components/RideLayout.tsx`** — **B4.**
  - Added support for `driverLocation` prop to render the driver's icon dynamically as they move, injecting the live coordinates into the Leaflet WebView.

---

### ✋ Manual verification — do these in order

#### Step 1 — Apply Migrations ⚠️ BLOCKING
1. Add `022_driver_locations_realtime.sql` to Supabase via SQL editor or `npm run migrate` to enable Postgres Changes on the `driver_locations` table.

#### Step 2 — Test Non-Move Jobs (B3)
1. **Fleet or Quick Job:** Create a fleet or quick-commerce delivery.
2. **Accept & Start:** Accept the delivery as a driver, and then tap to start it.
3. **Verify:** Ensure it successfully transitions to `in_progress` directly via `/start` without prompting for an OTP.

#### Step 3 — Test Live Location Tracking (B4)
1. **Move Job:** Create and accept a standard passenger ride.
2. **Driver App Movement:** Move the driver app's location (e.g., using an emulator's location simulation or by physically walking).
3. **Customer App:** Watch the live ride screen. The driver's car marker should update smoothly on the map, and the status text (e.g., "Driver is on the way") must **not** glitch or get corrupted with raw coordinate JSON payloads.
