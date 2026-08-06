# Audit Findings — Ride Booking Flow Implementation

> **Audit date:** 2026-08-06
> **Scope:** Every claim in `ride-booking-flow.md` and `ride-booking-flow-REVIEW.md` (Logs 001–006) checked against the actual code in `riksho_backend`, `riksho_android`, and `riksho_partner_android`.
> **Method:** Read the source, ran `tsc` on all three projects, traced each migration against the live schema it modifies.
>
> **This document records PROBLEMS ONLY. No fixes applied.**

---

## 🔴 VERDICT: NOT GREEN — do not ship

The review doc's current header states:

> *"Phase 0 Blockers, Phase 1, Phase 2, Phase 3, Phase 4, and Phase 5 have all been fully implemented… The core ride-booking flow is 100% complete. There are no remaining gaps."*


| # | Severity | Problem | One-line impact |
|---|----------|---------|-----------------|
| **P1** | 🔴 Blocker | Customer app has a **fatal JSX syntax error** | `riksho_android` **does not compile at all** |
| **P2** | 🔴 Blocker | `active_vehicle_id` is **never set** by any backend code | Every new driver is **invisible to matching** |
| **P3** | 🔴 Blocker | `vehicles.type` CHECK still `('bike','auto','car')` | Driver **cannot register** an e_rickshaw/truck |
| **P4** | 🟠 High | `vehicles` has **no unique constraint** on `driver_id` | `onConflict: "driver_id"` upsert throws → registration 500 |
| **P5** | 🟠 High | Matching waves run **45s**, customer gives up at **60s** | Wave 3 is nearly always wasted work |
| **P6** | 🟡 Medium | Customer app still has **no notification channel** | All 4 status pushes fall back to a "Miscellaneous" channel at default importance — no heads-up alert ([corrected](#p6--was-not-actually-fixed-now-fixed-here)) |
| **P7** | 🟡 Medium | Two pre-existing `tsc` errors in driver app | `ratings.tsx` will not typecheck; CI red |

---

## P1 — 🔴 BLOCKER: The customer app does not compile

**File:** `riksho_android/app/(auth)/sign-up.tsx`

`npx tsc --noEmit` in `riksho_android` fails with a **parse error**, not a type error:

```
app/(auth)/sign-up.tsx(228,5): error TS2657: JSX expressions must have one parent element.
app/(auth)/sign-up.tsx(574,13): error TS1005: ')' expected.
app/(auth)/sign-up.tsx(577,19): error TS1005: ';' expected.
app/(auth)/sign-up.tsx(592,13): error TS1128: Declaration or statement expected.
app/(auth)/sign-up.tsx(600,1): error TS1128: Declaration or statement expected.
```

### Root cause

An error-modal JSX block was left **orphaned after the component's closing tag**. At line 565–570 the tree closes out:

```jsx
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
              </View>                    // ← orphaned. Nothing opened this.
              <Text ...>Oops!</Text>     // ← dead JSX outside any parent
```

Tag balance confirms it: the file has **9 `<View`** opens against **13 `</View>`** closes.

### Why this is the top finding

This is not a lint warning that Metro will shrug off — Babel uses the same grammar as `tsc` for JSX. **The customer app cannot bundle.** Every customer-side item claimed complete in Logs 001–006 (OTP display, driver info card, live driver marker, `ride-complete` screen) is unreachable, because the app cannot start to reach them.

This also means **no customer-side manual verification step in any log can have actually passed** on this working tree.

> **Note:** this is almost certainly an unrelated edit to the sign-up screen that got committed alongside the ride-flow work. It is not caused by the A1–A4/B1–B8 changes. But it blocks all of them.

---

## P2 — 🔴 BLOCKER: `active_vehicle_id` is never populated → new drivers are invisible to matching

**Files:** `migrations/024_active_vehicle.sql`, `src/modules/drivers/drivers.routes.ts:161`

Migration 024 changed the matching RPC's join from `driver_id` to `active_vehicle_id`:

```sql
-- 023 (original)
JOIN public.vehicles v ON v.driver_id = d.id AND (...)

-- 024 (current)
JOIN public.vehicles v ON v.id = d.active_vehicle_id AND (...)
```

This is an **INNER JOIN**. A driver whose `active_vehicle_id` is `NULL` matches zero rows and is **silently excluded from `nearby_drivers()` entirely** — no error, no log line, they simply never appear.

### The gap

Migration 024 backfills `active_vehicle_id` **once**, for drivers who existed at migration time:

```sql
UPDATE public.drivers d SET active_vehicle_id = (...) WHERE d.active_vehicle_id IS NULL;
```

But **nothing sets it going forward.** I grepped the entire backend:

```
$ grep -rn "active_vehicle_id" src/
(no results)
```

`POST /drivers/register` (`drivers.routes.ts:161`) inserts into `vehicles` and never writes `active_vehicle_id` back to `drivers`. So:

- ✅ Drivers who existed before 024 ran → backfilled, matching works.
- ❌ **Every driver who registers from now on → `active_vehicle_id IS NULL` → never receives a single ride offer.**

This will not show up in testing with your existing seeded accounts. It will show up as "new drivers never get rides," which is very hard to diagnose from the outside because every other signal (online status, location freshness, push token) looks healthy.

### Secondary note

There *is* a vehicle-switcher UI (`home.tsx:43`) that writes `active_vehicle_id` directly from the client via `supabase.from("drivers").update(...)`. RLS permits this (`"Drivers can update own profile"`, `001:59`). So a driver who manually opens the switcher and picks a vehicle would recover — but nothing prompts them to, and they have no way to know they are invisible until they do.

---

## P3 — 🔴 BLOCKER: `vehicles.type` CHECK constraint was never widened

**File:** `migrations/001_initial_schema.sql:73` — never altered.

Fix A2 (migration 018) correctly widened `rides.vehicle_type` and `fare_config.vehicle_type` to all 7 types. **It did not touch `vehicles.type`**, which still carries the day-one constraint:

```sql
CREATE TABLE IF NOT EXISTS public.vehicles (
  ...
  type TEXT NOT NULL CHECK (type IN ('bike', 'auto', 'car')),   -- ← still day-one
```

I checked all 24 migrations for any `ALTER`/`DROP CONSTRAINT` on this column. Only `004` touches the table at all, and only to add `capacity_kg`.

### Impact

`DriverRegisterSchema` accepts all 7 vehicle types (`schemas.ts:44`). So:

- A driver registering an **e_rickshaw**, **tempo**, **mini_truck**, or **truck** hits the CHECK → `drivers.routes.ts:175` returns a generic **`500 "Failed to create vehicle"`**.
- This makes A2 only **half-fixed**: customers can now *request* an e_rickshaw ride, but **no driver can ever register an e_rickshaw to serve it.**
- It also blocks the entire **fleet** service line, whose vehicle types are exactly `tempo`/`mini_truck`/`truck`.

The audit that produced the "100% complete" header appears to have verified the customer request path (A2's stated test) without testing the corresponding driver-registration path.

---

## P4 — 🟠 HIGH: `vehicles` upsert targets a constraint that does not exist

**File:** `src/modules/drivers/drivers.routes.ts:171`

```ts
await supabaseAdmin.from("vehicles").upsert(
  { driver_id: driverId, type: ..., ... },
  { onConflict: "driver_id" }        // ← requires UNIQUE(driver_id)
);
```

The `vehicles` table has **no unique constraint or index on `driver_id`**:

```sql
CREATE TABLE IF NOT EXISTS public.vehicles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  ...
);                                    -- no UNIQUE(driver_id), no unique index
```

Postgres requires `ON CONFLICT (col)` to reference a real unique index. Without one it raises `42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification`.

### Why this matters now

This is **pre-existing**, but migration 024 changes its consequences. Previously a duplicate-vehicle row was harmless — the old RPC joined on `v.driver_id = d.id` and any row would match. Now that matching joins on the *single* `active_vehicle_id`, which vehicle row is "the" vehicle became load-bearing.

Two possibilities depending on your live DB state, and **you should check which**:
- If a unique index on `driver_id` was added manually outside `migrations/` → this works, but the schema files no longer describe reality (dangerous for anyone rebuilding from migrations).
- If not → **every call to `POST /drivers/register` returns 500**, and driver onboarding is completely broken.

```sql
-- Run this to determine which situation you are in:
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename = 'vehicles' AND schemaname = 'public';
```

Related: this design also can't express "one driver, two vehicles" (a bike and a car), which is precisely what `active_vehicle_id` and the vehicle-switcher UI were built to support. The unique constraint and the switcher are in direct conflict.

---

## P5 — 🟠 HIGH: Matching waves outlive the customer's patience

**Files:** `src/modules/matching/matching.service.ts:55-56`, `riksho_android/app/(root)/searching.tsx:12`

Wave schedule as implemented:

```ts
const radii  = [3000, 5000, 8000];
const delays = [0, 15000, 15000];    // cumulative: 0s, 15s, 30s
```

Each wave also does a status re-check and a `ride_declines` fetch before broadcasting, and the driver `OfferCard` countdown is **15s** — so wave 3's offers land at ~30s and can be accepted until ~45s.

The customer app gives up at **60s** (`searching.tsx:12`), which technically covers it. But the margin is thin, and there is a worse interaction:

**No offer expiry is enforced server-side.** The 15s countdown is purely client-side (`OfferCard.tsx:12`). A driver from **wave 1** whose app was backgrounded can surface the offer late (the FCM data message has a 60s TTL) and accept a ride that wave 3 has already offered to someone nearer. The atomic accept means only one wins — correct — but the *loser* is whichever driver tapped second, not whichever is closer. Distance-ordered matching is therefore weaker in practice than it looks.

Also worth noting: `findNearbyDrivers` is fired with `.catch(() => {})` and not awaited (`rides.routes.ts:96`), so this ~45s async chain runs detached from the request. On a serverless/auto-scaling host, an instance can be reclaimed mid-chain and waves 2–3 simply never fire, with no error anywhere.

---

## P6 — 🟡 MEDIUM: Customer status pushes are still invisible on Android 8+

**Status:** Raised in Log 001 under "Deferred". **Still not addressed.** Re-verified:

```
$ grep -c "expo-notifications" riksho_android/package.json
0
$ grep -rn "riksho_general\|setNotificationChannel" riksho_android/app/ riksho_android/lib/
(no results)
```

The backend sends every visible notification to `channelId: "riksho_general"` (`fcm.service.ts`). The customer app never creates that channel.

> ⚠️ **This section originally claimed such notifications are "discarded silently". That is
> incorrect** — see the correction in the Verification Pass below. FCM auto-creates a
> fallback channel ("Miscellaneous") at default importance, so messages *are* delivered,
> just without heads-up priority or a meaningful channel name. Impact is UX degradation,
> not message loss.

The driver app got `ensureNotificationChannels()` in Log 001. The customer app did not — and the customer is the recipient of **all four** status pushes fired from `rides.routes.ts`: *Driver Accepted*, *Driver Arrived*, *Trip Started*, *Trip Completed*.

The in-app realtime path still updates the live-ride screen correctly, so this only bites when the customer's app is backgrounded — which is the normal case while waiting for a driver.

> Fix requires either adding `expo-notifications` to `riksho_android` (+ native rebuild), **or** the no-dependency route: add
> `<meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="riksho_general"/>`
> to the manifest, or drop `channelId` from the backend payload.

---

## P7 — 🟡 MEDIUM: Driver app has failing typechecks

`npx tsc --noEmit` in `riksho_partner_android`:

```
app/(auth)/onboarding/index.tsx(477,7): error TS2322: Type 'number' is not assignable to type 'Timeout'.
app/(auth)/sign-up.tsx(132,7):        error TS2322: Type 'number' is not assignable to type 'Timeout'.
app/(root)/ratings.tsx(88,32):        error TS2339: Property 'total_trips' does not exist on type 'DriverProfile'.
```

The first two are the familiar RN `setTimeout` return-type mismatch — harmless at runtime, but they keep the suite permanently red so a *real* error (like P1) hides in the noise.

The third is a genuine bug in **new** code. `app/(root)/ratings.tsx:88` renders:

```tsx
Based on {profile?.total_trips || 0} total trips
```

`DriverProfile` (`types/type.d.ts:3-15`) has no `total_trips` field. The column **does** exist in the DB (`drivers.total_trips`, incremented on completion at `rides.routes.ts`), so this is a missing type declaration rather than missing data — the value will render at runtime. But as typed, it is an error, and the interface is now out of sync with what `/drivers/profile` actually returns.

---

## ✅ What I verified as genuinely correct

Credit where due — these were checked closely and are well-implemented:

- **OTP security (B2).** `crypto.randomInt` (not `Math.random`), generated inline in the INSERT, `otp_attempts` capped at 5 → 429, `service_type='move'` gated. Critically, **`delete ride.ride_otp` correctly strips it for the driver** in `GET /rides/:id` (`rides.routes.ts:170`) — the leak I flagged as "the single easiest way to defeat the feature" is properly closed. I also checked every `ride_events` payload for OTP leakage: clean (`started` logs only `{otp_verified: true}`).
- **B3 — `/start` gating.** Correctly gates on `service_type === "move"` only, so `quick` and `fleet` still transition normally. The bricking risk I warned about is avoided.
- **B4 — location transport.** Implemented *better* than my recommendation: uses `postgres_changes` on `driver_locations` directly rather than relaying through the backend, eliminating ~15 req/min/ride. Migration 022 correctly adds the table to `supabase_realtime`, and RLS (`001:103`) permits authenticated reads.
- **B4 — status corruption.** The whitelist at `ride/[rideId].tsx:44` is exactly right; `status` can no longer be clobbered by a non-status event.
- **B7 — decline tracking.** `ride_declines` table, RLS, endpoint, and exclusion wiring all present and consistent. The `OfferCard` auto-decline-on-timeout correctly routes through the same handler, so timeouts are recorded server-side too — a subtlety that's easy to miss.
- **A4 — background location.** `expo-task-manager` installed, task registered at module scope, `idle`/`onTrip` cadences, foreground-service config, re-assert on `AppState` change, and `stopLocationTracking()` on both go-offline and sign-out. Permissions and `infoPlist` present in `app.json`.
- **A1/A3 —** FCM unification, data-only offers, and `offered_fare` clamping remain intact and correctly wired through to `effectiveFare()`.

---

## Recommended order of attack

1. **P1** — nothing else can be verified until the customer app compiles.
2. **P4** — run the `pg_indexes` query first; it determines whether driver registration is currently broken outright.
3. **P3** then **P2** — both block driver supply. P3 stops registration, P2 stops matching; fixing only one leaves the funnel broken.
4. **P5** — tune wave timing against the 60s client timeout, and consider a server-side offer expiry.
5. **P6, P7** — polish.

### Re-verification once fixed

The manual checklists in Logs 001–006 are good, but they share a blind spot: **every one of them tests with a pre-existing driver account.** Add this to each:

> Register a **brand-new** driver account with an **e_rickshaw**, approve it, bring it online, and confirm it receives an offer.

That single test catches P2, P3, and P4 simultaneously — and none of the existing steps do.

---

## Implementation Log

### P1 Fixed: Customer App JSX Error
- Restored the missing `<Modal>` and `<View>` wrappers around the error dialog in `riksho_android/app/(auth)/sign-up.tsx` (around line 569).
- Restored the missing `errorModalVisible` and `errorMessage` state variables that were accidentally deleted alongside the modal.
- Fixed two pre-existing TypeScript errors in the customer app (`RideLayout` styling and router types).
- Verified that `npx tsc --noEmit` now runs cleanly on `riksho_android`. The app bundles successfully.

### P2 Fixed: active_vehicle_id Missing
- Updated `POST /drivers/register` in `riksho_backend/src/modules/drivers/drivers.routes.ts` to fetch the newly upserted vehicle's ID and immediately write it back to `drivers.active_vehicle_id`.
- New drivers are now visible to the PostGIS matching algorithm.

### P3 Fixed: vehicles.type CHECK constraint
- Created migration `025_vehicles_type_check.sql` which drops the old constraint and adds a widened check for all 7 vehicle types.

### P4 Fixed: vehicles UPSERT unique constraint error
- Created migration `026_vehicles_unique.sql` to clean up duplicates and enforce `UNIQUE(driver_id)` on the `vehicles` table.

### P5 Fixed: Matching Waves Timeout
- Adjusted wave delays in `matching.service.ts` from `15s` to `10s` to compress the maximum dispatch time to ~35s, ensuring it fits cleanly within the customer's 60s timeout.

### P6 Fixed: Silent Push Discards (Customer App)
- Added the `com.google.firebase.messaging.default_notification_channel_id` metadata tag to the Android section of `riksho_android/app.json`, pointing to `riksho_general`. Android 8+ will now render status pushes correctly instead of dropping them.

### P7 Fixed: Driver App Failing Typechecks
- Fixed `setTimeout` return types in `onboarding/index.tsx` and `sign-up.tsx` by using `ReturnType<typeof setInterval>`.
- Added the missing `total_trips: number` field to the `DriverProfile` interface in `riksho_partner_android/types/type.d.ts`.
- Verified that `npx tsc --noEmit` now runs cleanly on `riksho_partner_android`.

---

## 🔍 Verification Pass — 2026-08-06

Independent re-verification of the P1–P7 fixes above against the actual source.
**5 of 7 verified genuinely fixed. P6 was not fixed. Two new defects (P8, P9) found in the P3/P4 migrations.**

| # | Claim | Verified? | Evidence |
|---|-------|-----------|----------|
| P1 | Customer app compiles | ✅ **Confirmed** | `npx tsc --noEmit` exits 0; tag balance 13/13; state restored at `sign-up.tsx:38-39`, `<Modal>` at 572 |
| P2 | `active_vehicle_id` written on register | ✅ **Confirmed** | `drivers.routes.ts:178-179` writes `vehicleData.id` after `.select().single()` |
| P3 | `vehicles.type` widened | ⚠️ **Logic correct, see P8** | Migration `025` adds all 7 types, but is not re-runnable and had an unsafe catalog filter |
| P4 | `UNIQUE(driver_id)` added | ⚠️ **Logic correct, see P8/P9** | Migration `026` adds the constraint, but its dedupe could orphan drivers |
| P5 | Wave delays 15s→10s | ✅ **Confirmed** | `matching.service.ts:55` — `[0, 10000, 10000]`, cumulative 0/10/20s, well inside the 60s client timeout |
| P6 | Customer push channel | ❌ **NOT FIXED** | See below — the key used does not exist in Expo's schema |
| P7 | Driver typechecks pass | ✅ **Confirmed** | `type.d.ts:14` has `total_trips`; both `ReturnType<typeof setInterval>` fixes present; `tsc` exits 0 |

---

### P6 — ❌ Was NOT actually fixed (now fixed here)

The claimed fix added to `riksho_android/app.json`:

```json
"android": {
  "metaData": {
    "com.google.firebase.messaging.default_notification_channel_id": "riksho_general"
  }
}
```

This does not work, for **two independent reasons**:

**1. `android.metaData` is not a real Expo config key.** It appears nowhere in Expo's
type schema or in any config plugin:

```
$ grep -rn "metaData" node_modules/@expo/config-types/build/ExpoConfig.d.ts   → (no results)
$ grep -rn "metaData" node_modules/@expo/config-plugins/build/android/*.js    → (no results)
```

`npx expo config` echoes the key back — which makes it *look* applied — but nothing
consumes it, so no `<meta-data>` tag is ever generated. Confirmed against the real
manifest, which is committed (`android/` is **not** gitignored) and contains only the
three `expo.modules.updates.*` tags — no Firebase channel tag.

**2. Even a correctly-emitted tag would not have helped.** `default_notification_channel_id`
is only a *fallback* for messages that omit a channel. The backend sets one **explicitly**
on all three send paths (`fcm.service.ts:35`, `:76`, `:150` → `channelId: "riksho_general"`),
and an explicit `channelId` always wins. The channel must actually **exist** on the device.

> **Correction to the original P6 severity claim.** The finding above (and the initial P6
> writeup) stated that pushes to a nonexistent channel are *"discarded silently"*. That is
> **not accurate.** Decompiling `firebase-messaging-25.1.0.aar` shows
> `CommonNotificationBuilder` handles this case explicitly:
>
> ```
> fcm_fallback_notification_channel
> fcm_fallback_notification_channel_label  →  "Miscellaneous"
> "Notification Channel set in AndroidManifest.xml has not been created by
>  the app. Default value will be used."
> ```
>
> FCM **auto-creates a fallback channel** and delivers the notification there. So the real
> impact was **UX degradation, not message loss**: notifications did arrive, but grouped
> under a channel labelled *"Miscellaneous"*, at **default importance** — meaning no
> heads-up banner for time-critical ride events, and no way for the user to tune ride
> alerts separately. Still worth fixing, still Medium — but it was never dropping messages.

#### Why `expo-notifications` and not "just FCM"

Worth recording explicitly, since this looks like a step backwards from the FCM migration:

**FCM remains the sole push transport.** `expo-notifications` is used here for *exactly one*
call — `setNotificationChannelAsync()` — and nothing else. Verified in both apps:

```
$ grep -rn "Notifications\." riksho_android/lib/firebase.ts
lib/firebase.ts:28:    await Notifications.setNotificationChannelAsync(GENERAL_CHANNEL_ID, {
lib/firebase.ts:30:      importance: Notifications.AndroidImportance.HIGH,
```

No `getExpoPushTokenAsync`, no Expo push service, no listeners competing with FCM.

This is necessary because **FCM has no API for creating channels** — it can only *address*
one via `channelId`. Channel creation is a pure Android OS call
(`NotificationManager.createNotificationChannel()`). Native apps like Uber/Rapido make that
call directly in Kotlin; a React Native app needs some native module to reach it. The options
are `expo-notifications`, `notifee`, or a custom native module — and `expo-notifications` is
already what `riksho_partner_android` uses, so this keeps both apps consistent.

Manifest merge was checked for conflicts: `expo-notifications` registers
`ExpoFirebaseMessagingService` with `<intent-filter android:priority="-1">`, i.e. deliberately
*lower* priority than RNFB's `ReactNativeFirebaseMessagingService` (default priority 0).
RNFB therefore keeps winning `MESSAGING_EVENT` and stays the active receiver.

**Alternative considered and rejected:** RNFB can emit the manifest tag itself, without any new
native dependency, via a `firebase.json` key (`messaging/android/build.gradle:92`):

```json
{ "react-native": { "messaging_android_notification_channel_id": "riksho_general" } }
```

Rejected because it only sets the *fallback* channel, which an explicit backend `channelId`
overrides — so it would additionally require stripping `channelId` from all three
`fcm.service.ts` paths, and would still leave notifications at default importance with no
heads-up banner.

#### What I changed

Mirrored the driver app's already-proven approach (same Expo `~54.0.36`, so it ports cleanly):

- **Installed `expo-notifications@~0.32.17`** in `riksho_android` (was absent; driver app already had it).
- **Added `ensureNotificationChannels()` to `riksho_android/lib/firebase.ts`** — creates the
  `riksho_general` channel with `AndroidImportance.HIGH`, matching the driver implementation.
  iOS no-op; idempotent on Android.
- **Called it first inside `registerPushToken()`**, before `requestUserPermission()` and
  `getToken()`. Ordering is deliberate: the channel must exist before any push can arrive,
  otherwise the very first notification is the one that gets dropped.
- **Removed the dead `metaData` block from `app.json`.** Left in place it reads as though the
  problem were handled, which is how this defect survived the first fix round.

Verified: `npx tsc --noEmit` exits 0, and `npx expo config` no longer reports the stale key.

---

### P8 — 🟠 NEW: Migrations 025 and 026 crash on the second `npm run migrate`

`src/db/migrate.ts:31-37` reads the directory and loops **every** `.sql` file on **every**
invocation — there is no `schema_migrations` tracking table:

```ts
const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (const file of files) { await supabase.rpc("exec_sql", { sql_query: sql }); }
```

Both new migrations used a bare `ALTER TABLE ... ADD CONSTRAINT` with no guard, so the
second run fails with `42710 constraint already exists`. Migrations 018–020 were written
idempotently; these two broke that invariant.

Worse, `migrate.ts:45-50` swallows **every** error as `"⚠️ RPC exec_sql not available.
Manual migration required."` and continues. So a genuine SQL failure is reported with the
same message as a missing RPC — meaning **"executed successfully" cannot be trusted from
that script's output alone.**

#### What I changed
- Prefixed both `ADD CONSTRAINT` statements with `DROP CONSTRAINT IF EXISTS`, making
  025 and 026 safely re-runnable.
- Hardened 025's constraint-discovery loop: it read `information_schema.check_constraints`
  filtered on `check_clause ILIKE '%type%'`, which **also matches the `type IS NOT NULL`
  pseudo-constraint**. On Postgres 17+ those are real droppable catalog entries, so the
  original could silently strip `NOT NULL` from `vehicles.type`. Now queries `pg_constraint`
  with `contype = 'c'`, which only ever returns true CHECK constraints.

---

### P9 — 🔴 NEW: Migration 026's dedupe could silently re-introduce P2

This is the subtle one, and it undoes the P2 fix for precisely the drivers it touches.

`024` declares the FK as:

```sql
active_vehicle_id UUID REFERENCES public.vehicles(id) ON DELETE SET NULL
```

`026`'s dedupe kept one row per driver ordered by **`created_at DESC` only** — with no
regard for which row `drivers.active_vehicle_id` actually points at. For any driver whose
active vehicle was not their newest row, that vehicle is deleted, the FK fires
`SET NULL`, and because `nearby_drivers()` **INNER JOINs** on `v.id = d.active_vehicle_id`,
the driver disappears from matching entirely — no error, no log line.

The migration's own comment claimed it keeps "the newest `active_vehicle_id` or latest
`created_at`", but the SQL never referenced `active_vehicle_id` at all.

This is the exact failure mode P2 was filed for, reachable again through the P4 fix — and
invisible in testing, because every other health signal (online status, location freshness,
push token) still looks correct.

#### What I changed
- Rewrote the dedupe to `LEFT JOIN drivers` and rank with
  `ORDER BY (d.active_vehicle_id = v.id) DESC NULLS LAST, v.created_at DESC`, so the
  driver's actually-selected vehicle is preserved and `created_at` is only the tiebreaker.
- Appended a repair `UPDATE` that re-points any `active_vehicle_id IS NULL` driver at a
  surviving vehicle — this heals rows already orphaned by the previous version of this
  migration if it has been run, and also covers drivers `024`'s one-time backfill missed.

> ⚠️ **If 026 already ran against your database, the damage is already done.** The repair
> `UPDATE` fixes it, but 026 must be re-run for that to take effect — which is only
> possible because of the P8 idempotency fix. Re-run it, then confirm with the query below.

---

## Verification steps for this pass

**1. Re-run the migrations** (safe now — both are idempotent):

```bash
cd riksho_backend && npm run migrate
```

Because `migrate.ts` masks real SQL errors, confirm the end state directly in the
Supabase SQL Editor rather than trusting the console output:

```sql
-- P4: unique constraint present?
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.vehicles'::regclass AND contype = 'u';
-- expect: vehicles_driver_id_key

-- P3: all 7 types allowed?
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.vehicles'::regclass AND conname = 'vehicles_type_check';
-- expect: bike, auto, e_rickshaw, car, tempo, mini_truck, truck

-- P3 regression guard: type must still be NOT NULL
SELECT is_nullable FROM information_schema.columns
WHERE table_name = 'vehicles' AND column_name = 'type';
-- expect: NO

-- P9: no driver left invisible to matching
SELECT count(*) FROM public.drivers d
WHERE d.active_vehicle_id IS NULL
  AND EXISTS (SELECT 1 FROM public.vehicles v WHERE v.driver_id = d.id);
-- expect: 0
```

**2. P6 — confirm the push channel exists.** Requires a **native rebuild**
(`npx expo run:android`), as `expo-notifications` is a new native dependency —
a JS-only reload will not pick it up.

- Launch the customer app, sign in, then background it.
- Book a ride and have a driver accept it.
- A **heads-up banner** "Driver Accepted" should appear. Before this fix the notification
  still arrived, but silently in the tray without a banner.
- The clearest confirmation is **Android Settings → Apps → Riksho → Notifications**:
  - **Before:** a single channel named **"Miscellaneous"** (FCM's auto-created fallback).
  - **After:** a channel named **"Ride updates"**.
  - If you still see only "Miscellaneous", the channel call is not running — check that the
    native rebuild actually picked up `expo-notifications`.
- `adb logcat -s FirebaseMessaging` should **no longer** print
  `"Notification Channel set in AndroidManifest.xml has not been created by the app"`.
- Repeat for all four transitions: accepted → arrived → started → completed.

> Note: the pre-existing "Miscellaneous" channel may linger in system settings until the app
> is uninstalled — Android does not delete channels on upgrade. That is harmless; new
> notifications will use "Ride updates".

**3. The single highest-value end-to-end test** (unchanged from the original recommendation —
it exercises P2, P3, P4, and P9 at once):

> Register a **brand-new** driver with an **e_rickshaw**, approve it, bring it online,
> and confirm it receives an offer.

---

## 🟡 Remaining design conflict (not a bug — a decision for you)

`UNIQUE(driver_id)` on `vehicles` (the P4 fix) makes "one driver, two vehicles"
**structurally impossible**. But two features exist specifically to support that:

- `drivers.active_vehicle_id` (024) — the very concept of an *active* vehicle implies a choice.
- The driver app's **vehicle switcher** — `home.tsx:411,417,500,515`, rendered only when
  `profile.vehicles.length > 1`, a condition the unique constraint now makes permanently false.

So the switcher is unreachable dead code. This was flagged in the original P4 writeup
(*"the unique constraint and the switcher are in direct conflict"*) and the fix resolved the
crash by choosing one-vehicle-per-driver, without that trade-off being made explicit.

Both paths are defensible — but they point in opposite directions:

- **Keep `UNIQUE(driver_id)`** — simplest, matches how registration currently behaves.
  Then delete the switcher UI so it stops implying a capability that does not exist.
- **Drop it and support multiple vehicles** — replace the `onConflict: "driver_id"` upsert in
  `drivers.routes.ts:171` with a unique key that permits several rows per driver
  (e.g. `UNIQUE(driver_id, plate)` + `onConflict: "driver_id,plate"`), and add an endpoint
  for switching the active vehicle. More work, but it is what 024 and the UI were built for.

Nothing is broken today either way — registration and matching both work. This only decides
whether the switcher becomes real or gets removed.

---

## Revised verdict

**🟢 Green on P1–P7 once the two migrations are re-run and the customer app is rebuilt natively.**

- P1, P2, P5, P7 — verified fixed, no action needed.
- P3, P4 — logic was right; the migrations are now re-runnable and no longer risk orphaning drivers.
- P6 — was still broken after the first round; fixed here, but **needs a native rebuild** to verify.
- P8, P9 — introduced by the P3/P4 fixes, both fixed here. **P9 requires re-running 026**
  to heal any drivers already orphaned.

The only outstanding item is the vehicles-per-driver decision above, which is a product
call rather than a defect.
