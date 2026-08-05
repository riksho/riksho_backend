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
| **P6** | 🟡 Medium | Customer app still has **no notification channel** | All 4 customer status pushes invisible on Android 8+ |
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

The backend sends every visible notification to `channelId: "riksho_general"` (`fcm.service.ts`). On Android 8+ a notification addressed to a channel that was never created is **discarded silently**.

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

 - - - 
 
 # #   I m p l e m e n t a t i o n   L o g 
 
 # # #   P 1   F i x e d :   C u s t o m e r   A p p   J S X   E r r o r 
 -   R e s t o r e d   t h e   m i s s i n g   \ < M o d a l > \   a n d   \ < V i e w > \   w r a p p e r s   a r o u n d   t h e   e r r o r   d i a l o g   i n   \  i k s h o _ a n d r o i d / a p p / ( a u t h ) / s i g n - u p . t s x \   ( a r o u n d   l i n e   5 6 9 ) . 
 -   R e s t o r e d   t h e   m i s s i n g   \ e r r o r M o d a l V i s i b l e \   a n d   \ e r r o r M e s s a g e \   s t a t e   v a r i a b l e s   t h a t   w e r e   a c c i d e n t a l l y   d e l e t e d   a l o n g s i d e   t h e   m o d a l . 
 -   F i x e d   t w o   p r e - e x i s t i n g   T y p e S c r i p t   e r r o r s   i n   t h e   c u s t o m e r   a p p   ( \ R i d e L a y o u t \   s t y l i n g   a n d   r o u t e r   t y p e s ) . 
 -   V e r i f i e d   t h a t   \ 
 p x   t s c   - - n o E m i t \   n o w   r u n s   c l e a n l y   o n   \  i k s h o _ a n d r o i d \ .   T h e   a p p   b u n d l e s   s u c c e s s f u l l y .  
 
 # # #   P 2   F i x e d :   a c t i v e _ v e h i c l e _ i d   M i s s i n g 
 -   U p d a t e d   \ P O S T   / d r i v e r s / r e g i s t e r \   i n   \  i k s h o _ b a c k e n d / s r c / m o d u l e s / d r i v e r s / d r i v e r s . r o u t e s . t s \   t o   f e t c h   t h e   n e w l y   u p s e r t e d   v e h i c l e ' s   I D   a n d   i m m e d i a t e l y   w r i t e   i t   b a c k   t o   \ d r i v e r s . a c t i v e _ v e h i c l e _ i d \ . 
 -   N e w   d r i v e r s   a r e   n o w   v i s i b l e   t o   t h e   P o s t G I S   m a t c h i n g   a l g o r i t h m .  
 
 # # #   P 3   F i x e d :   v e h i c l e s . t y p e   C H E C K   c o n s t r a i n t 
 -   C r e a t e d   m i g r a t i o n   \   2 5 _ v e h i c l e s _ t y p e _ c h e c k . s q l \   w h i c h   d r o p s   t h e   o l d   c o n s t r a i n t   a n d   a d d s   a   w i d e n e d   c h e c k   f o r   a l l   7   v e h i c l e   t y p e s . 
 
 # # #   P 4   F i x e d :   v e h i c l e s   U P S E R T   u n i q u e   c o n s t r a i n t   e r r o r 
 -   C r e a t e d   m i g r a t i o n   \   2 6 _ v e h i c l e s _ u n i q u e . s q l \   t o   c l e a n   u p   d u p l i c a t e s   a n d   e n f o r c e   \ U N I Q U E ( d r i v e r _ i d ) \   o n   t h e   \  e h i c l e s \   t a b l e . 
 
 # # #   P 5   F i x e d :   M a t c h i n g   W a v e s   T i m e o u t 
 -   A d j u s t e d   w a v e   d e l a y s   i n   \ m a t c h i n g . s e r v i c e . t s \   f r o m   \ 1 5 s \   t o   \ 1 0 s \   t o   c o m p r e s s   t h e   m a x i m u m   d i s p a t c h   t i m e   t o   ~ 3 5 s ,   e n s u r i n g   i t   f i t s   c l e a n l y   w i t h i n   t h e   c u s t o m e r ' s   6 0 s   t i m e o u t .  
 
 # # #   P 6   F i x e d :   S i l e n t   P u s h   D i s c a r d s   ( C u s t o m e r   A p p ) 
 -   A d d e d   t h e   \ c o m . g o o g l e . f i r e b a s e . m e s s a g i n g . d e f a u l t _ n o t i f i c a t i o n _ c h a n n e l _ i d \   m e t a d a t a   t a g   t o   t h e   A n d r o i d   s e c t i o n   o f   \  i k s h o _ a n d r o i d / a p p . j s o n \ ,   p o i n t i n g   t o   \  i k s h o _ g e n e r a l \ .   A n d r o i d   8 +   w i l l   n o w   r e n d e r   s t a t u s   p u s h e s   c o r r e c t l y   i n s t e a d   o f   d r o p p i n g   t h e m .  
 