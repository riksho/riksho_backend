# Riksho — Complete Ride Booking Flow (End-to-End)

> **Master implementation plan** covering every screen, API call, real-time event, and database change needed to take a ride from "Find a Driver" to "Ride Complete" across the **Customer App**, **Driver App**, and **Backend**.

---

## Architecture Overview

```
┌─────────────────────┐       ┌─────────────────────┐
│   Customer App      │       │   Driver App         │
│ (riksho_android)    │       │ (riksho_partner)     │
│                     │       │                      │
│ Expo + React Native │       │ Expo + React Native  │
│ Supabase Realtime   │◄─────►│ Supabase Realtime    │
│ fetchAPI → Backend  │       │ fetchAPI → Backend   │
└────────┬────────────┘       └────────┬─────────────┘
         │                             │
         │  HTTPS (REST)               │  HTTPS (REST)
         │                             │
         ▼                             ▼
┌──────────────────────────────────────────────────────┐
│              riksho_backend (Fastify)                 │
│                                                      │
│  Rides Module ─── Matching Service ─── Broadcast Svc │
│  Fares Module ─── Drivers Module  ─── Push Service   │
│                                                      │
│  Supabase (Postgres + Realtime + Storage)            │
└──────────────────────────────────────────────────────┘
```

**Tech Stack (no changes needed):**
| Layer | Technology | Already In Use |
|-------|-----------|----------------|
| Backend | Fastify + TypeScript + Zod | ✅ |
| Database | Supabase (Postgres) | ✅ |
| Realtime | Supabase Realtime Broadcast (REST API) | ✅ |
| Push Notifications | Expo Push API | ✅ |
| Routing (OSRM) | `router.project-osrm.org` | ✅ |
| Maps (Leaflet) | Google Maps tiles via WebView | ✅ |
| Auth | Supabase Auth (phone OTP) | ✅ |

---

## Current State Audit — What Already Works

| Component | Status | Notes |
|-----------|--------|-------|
| `POST /rides` — Create ride | ✅ Built | Creates ride, calls `findNearbyDrivers` |
| `POST /rides/estimate` — Fare estimate | ✅ Built | Returns per-vehicle-type pricing |
| `POST /rides/:id/accept` — Driver accepts | ✅ Built | Atomic claim (first driver wins) |
| `POST /rides/:id/arrived` — Driver arrived | ✅ Built | Status → `arriving` |
| `POST /rides/:id/start` — Start trip | ✅ Built | Status → `in_progress` |
| `POST /rides/:id/complete` — End trip | ✅ Built | Fare recompute, earnings ledger |
| `POST /rides/:id/cancel` — Cancel | ✅ Built | Participant-checked |
| `broadcastRideOffer()` — Notify drivers | ✅ Built | REST broadcast to `driver:{id}` |
| `broadcastRideStatus()` — Notify customer | ✅ Built | REST broadcast to `ride:{rideId}` |
| `findNearbyDrivers()` — Matching | ✅ Built | Bounding-box, 5km, vehicle match |
| `sendPush()` — Background push | ✅ Built | Expo Push API |
| Customer `find-ride.tsx` — Vehicle select | ✅ Built | Estimate + confirm + request |
| Customer `searching.tsx` — Wait screen | ✅ Built | Realtime listener, 60s timeout |
| Customer `ride/[rideId].tsx` — Live ride | ✅ Built | Status banner + cancel |
| Driver `OfferCard.tsx` — Offer popup | ✅ Built | 15s countdown, accept/decline |
| Driver `ride/[rideId].tsx` — Active trip | ✅ Built | State transitions, POD |
| Driver home `broadcastChannel` listener | ✅ Built | `driver:{id}` subscription |

### What's Missing (Gaps This Plan Fills)

| Gap | Impact | Phase |
|-----|--------|-------|
| **No ride OTP verification** — anyone can start the trip | 🔴 Safety-critical | Phase 1 |
| **Customer doesn't see driver info** after acceptance | 🟠 UX-critical | Phase 2 |
| **Driver doesn't see customer name/phone** in offer | 🟠 UX-critical | Phase 2 |
| **No live driver location tracking** on customer map | 🟠 UX-critical | Phase 3 |
| **No arrival detection** — driver manually taps "Complete" | 🟡 Nice-to-have | Phase 4 |
| **No ride completion summary screen** (just Alert) | 🟡 Polish | Phase 5 |
| **No rating flow** after completion | 🟡 Polish | Phase 5 |
| **No driver ETA shown** to customer | 🟡 Polish | Phase 3 |

---

## Phase 1 — Ride OTP (Safety-Critical)

> **Goal:** When a driver arrives at the pickup, the customer shows a 4-digit OTP. The driver enters it to start the trip. This prevents wrong-passenger pickups and disputes.

### 1.1 Database Migration (`018_ride_otp.sql`)

```sql
ALTER TABLE public.rides
  ADD COLUMN IF NOT EXISTS ride_otp TEXT;
```

- `ride_otp`: 4-digit string, generated server-side when ride is created.

**File:** `riksho_backend/migrations/018_ride_otp.sql`

### 1.2 Backend Changes

#### `rides.routes.ts` — Generate OTP on ride creation

In `POST /rides`, after the ride is inserted, generate a random 4-digit OTP and store it:

```typescript
const otp = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit

// Update the ride with the OTP
await supabaseAdmin.from("rides").update({ ride_otp: otp }).eq("id", ride.id);
```

Return the OTP in the response to the customer (but NOT in the broadcast to drivers):

```typescript
return reply.status(201).send({
  ride_id: ride.id,
  status: ride.status,
  fare_estimate: fareEstimate,
  distance_km: ...,
  duration_min: ...,
  ride_otp: otp, // Customer sees this
});
```

#### `rides.routes.ts` — New endpoint: `POST /rides/:id/verify-otp`

```typescript
// POST /rides/:id/verify-otp — Driver submits OTP to start trip
app.post("/rides/:id/verify-otp", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
  const { id } = request.params;
  const driverId = request.user!.id;
  const { otp } = request.body as { otp: string };

  const { data: ride } = await supabaseAdmin
    .from("rides")
    .select("ride_otp, driver_id, status")
    .eq("id", id)
    .single();

  if (!ride || ride.driver_id !== driverId) {
    return reply.status(403).send({ error: "Not authorized" });
  }

  if (ride.status !== "arriving") {
    return reply.status(409).send({ error: "Driver must arrive first" });
  }

  if (ride.ride_otp !== otp) {
    return reply.status(400).send({ error: "Invalid OTP" });
  }

  // OTP verified — transition to in_progress
  const { data } = await supabaseAdmin
    .from("rides")
    .update({ status: "in_progress", started_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "started", payload: { otp_verified: true } });

  broadcastRideStatus(id, "in_progress", {});
  sendPush([data.customer_id], { title: "Trip Started", body: "Your trip has started.", data: { ride_id: id, status: "in_progress" } }).catch(() => {});

  return reply.send({ status: "in_progress" });
});
```

#### Modify `POST /rides/:id/start` — Block direct start (require OTP)

Change the existing `/start` endpoint so it returns a `400` error saying OTP verification is required. This forces the driver app to use `/verify-otp` instead.

### 1.3 Customer App Changes

#### `searching.tsx` — Store and pass OTP

When the ride is created, the response includes `ride_otp`. Pass it to the ride screen:

```typescript
router.push(`/(root)/ride/${data.ride_id}?otp=${data.ride_otp}`);
```

#### `ride/[rideId].tsx` — Show OTP to customer

When ride status is `arriving` (driver has arrived), display a large, prominent OTP:

```
┌──────────────────────────┐
│   Your Ride OTP          │
│                          │
│      ██ 4 8 2 7 ██       │
│                          │
│   Share this with your   │
│   driver to start trip   │
└──────────────────────────┘
```

### 1.4 Driver App Changes

#### `ride/[rideId].tsx` — OTP entry instead of "Start Trip"

When the ride status is `arriving`, instead of showing a "Start Trip" button, show an OTP input field:

```
┌──────────────────────────┐
│   Enter Ride OTP         │
│                          │
│   [_] [_] [_] [_]        │
│                          │
│   [  Verify & Start  ]   │
└──────────────────────────┘
```

The driver enters the 4-digit code → calls `POST /rides/:id/verify-otp` → if valid, ride transitions to `in_progress`.

### 1.5 Manual Verification — Phase 1

1. **Create a ride** from customer app → check that the response contains `ride_otp`
2. **Accept the ride** from driver app → navigate to active trip
3. **Tap "I've Arrived"** from driver app → status becomes `arriving`
4. **On customer app**, verify the OTP is prominently displayed
5. **On driver app**, enter the OTP → verify it calls `/verify-otp` → ride starts
6. **Enter wrong OTP** → verify it shows an error and does NOT start the trip
7. **Check Supabase** `rides` table → confirm `ride_otp` column exists and is populated

---

## Phase 2 — Rich Driver Info & Customer Context

> **Goal:** After acceptance, the customer sees the driver's name, vehicle, rating, and plate number. The driver sees the customer's name and phone in the offer and on the active trip screen.

### 2.1 Backend Changes

#### `rides.routes.ts` — Include driver profile in acceptance broadcast

When the driver accepts (inside `POST /rides/:id/accept`), fetch the driver's profile and broadcast it:

```typescript
const { data: driverInfo } = await supabaseAdmin
  .from("drivers")
  .select("name, phone, rating, vehicles(type, plate, model)")
  .eq("id", driverId)
  .single();

broadcastRideStatus(id, "accepted", {
  driver_id: driverId,
  driver_name: driverInfo?.name,
  driver_phone: driverInfo?.phone,
  driver_rating: driverInfo?.rating,
  vehicle_type: driverInfo?.vehicles?.[0]?.type,
  vehicle_plate: driverInfo?.vehicles?.[0]?.plate,
  vehicle_model: driverInfo?.vehicles?.[0]?.model,
});
```

#### `rides.routes.ts` — Include customer info in ride response

In `GET /rides/:id`, if the caller is the driver, include the customer's name and phone:

```typescript
if (ride.driver_id === userId) {
  const { data: customer } = await supabaseAdmin
    .from("users")
    .select("name, phone")
    .eq("id", ride.customer_id)
    .single();
  ride.customer_name = customer?.name;
  ride.customer_phone = customer?.phone;
}
```

#### `matching.service.ts` — Include customer name in offer broadcast

When broadcasting to drivers, include the customer's name:

```typescript
const { data: customer } = await supabaseAdmin
  .from("users")
  .select("name")
  .eq("id", rideData.customer_id)
  .single();

// Add to payload:
customer_name: customer?.name,
```

### 2.2 Customer App Changes

#### `ride/[rideId].tsx` — Driver info card

After ride status becomes `accepted`, display a card:

```
┌──────────────────────────────┐
│  🚗  Raj Kumar               │
│      ⭐ 4.8 · Honda Activa   │
│      MH12AB1234              │
│                              │
│  [📞 Call]    [💬 Chat]       │
└──────────────────────────────┘
```

### 2.3 Driver App Changes

#### `OfferCard.tsx` — Show customer name

Add the customer's name to the offer popup:

```
🚗 New Ride Request!
👤 Priya S.
📍 Spencers Retail, Rampur → Budge Budge Station
₹85 · 3.2 km · Auto
```

#### `ride/[rideId].tsx` — Show customer name + call button

The active trip screen already has a Call button. Wire it to `ride.customer_phone` (which the backend now returns).

### 2.4 Manual Verification — Phase 2

1. **Request ride** → driver accepts → check customer app shows driver name, vehicle, plate
2. **On driver app**, check the offer card shows customer name
3. **On active trip**, tap "Call" → verify it dials the customer's phone number
4. **Check `GET /rides/:id`** response → verify it includes `customer_name` and `customer_phone` for the driver

---

## Phase 3 — Live Driver Location on Customer Map

> **Goal:** After acceptance, the customer's map shows the driver's real-time location moving toward pickup (and then toward destination during the trip).

### 3.1 Backend Changes

#### `drivers.routes.ts` — Broadcast driver location on update

When a driver posts their location (`POST /drivers/location`), if they are `on_trip`, broadcast their coordinates to the ride channel:

```typescript
// After upserting location, check if driver is on a trip
if (driverStatus === "on_trip") {
  const { data: activeRide } = await supabaseAdmin
    .from("rides")
    .select("id")
    .eq("driver_id", driverId)
    .in("status", ["accepted", "arriving", "in_progress"])
    .single();

  if (activeRide) {
    broadcastRideStatus(activeRide.id, "driver_location", {
      lat, lng,
    });
  }
}
```

This reuses the existing `ride:{rideId}` channel. The customer app already subscribes to it.

### 3.2 Customer App Changes

#### `ride/[rideId].tsx` — Track driver marker on map

Listen for `driver_location` events on the existing channel:

```typescript
if (newStatus === "driver_location") {
  setDriverLocation({
    latitude: payload.payload.lat,
    longitude: payload.payload.lng,
  });
}
```

Pass `driverLocation` to the Map component as a moving marker.

#### `Map.tsx` — Add driver marker

Add a new marker type for the approaching driver (🛺 or a car icon), updated every time `driverLocation` changes. Calculate and display ETA using the OSRM distance.

### 3.3 Driver App — No changes

The driver already streams location every 4s during active trips (in `ride/[rideId].tsx`, lines 60-82). The backend just needs to relay it.

### 3.4 Manual Verification — Phase 3

1. **Request and accept a ride**
2. **On customer map**, verify a driver marker appears and moves
3. **Check the Supabase Realtime inspector** → verify `driver_location` events flow through `ride:{rideId}`
4. **On an Android emulator**, change the simulated GPS → verify the customer map updates in ~4 seconds
5. **Check driver app** → verify location streaming continues at 4s intervals

---

## Phase 4 — Destination Arrival Detection

> **Goal:** When the driver reaches the destination (within ~100m), the app automatically prompts "Complete Trip" instead of requiring manual tap.

### 4.1 Driver App Changes

#### `ride/[rideId].tsx` — Geo-fence check

During `in_progress`, after each location update, calculate the Haversine distance between the driver's current position and the destination:

```typescript
const haversine = (lat1, lon1, lat2, lon2) => {
  // Standard haversine formula
  // Returns distance in meters
};

// In the location streaming interval:
const distToDest = haversine(lat, lng, ride.dest_lat, ride.dest_lng);
if (distToDest < 100) {
  setNearDestination(true);
}
```

When `nearDestination` is true, change the "Complete Trip" button to a pulsing/highlighted state with text like "You've arrived — Complete Trip".

### 4.2 Manual Verification — Phase 4

1. **Start a trip** with a known destination
2. **Set emulator GPS** to the destination coordinates
3. **Verify** the app detects arrival and highlights the Complete button
4. **Verify** it does NOT auto-complete (still requires driver tap for safety)

---

## Phase 5 — Ride Completion Summary & Rating

> **Goal:** After trip completion, both customer and driver see a polished summary screen (not just an Alert). Both can rate each other.

### 5.1 Customer App Changes

#### New screen: `ride-complete.tsx`

Instead of showing `Alert.alert("Ride Completed")`, navigate to a dedicated completion screen:

```
┌────────────────────────────────┐
│           ✅                    │
│    Ride Complete!               │
│                                │
│    ₹85                         │
│    Cash Payment                │
│                                │
│    Spencers Retail → Station   │
│    3.2 km · 12 min             │
│                                │
│    Rate your driver:           │
│    ★ ★ ★ ★ ★                   │
│                                │
│    [  Done  ]                  │
└────────────────────────────────┘
```

#### Rating submission

On tapping a star, call:

```typescript
await fetchAPI("/ratings", {
  method: "POST",
  body: JSON.stringify({
    ride_id: rideId,
    stars: selectedStars,
    comment: optionalComment,
  }),
});
```

### 5.2 Driver App Changes

#### Modify completion handler in `ride/[rideId].tsx`

Instead of `Alert.alert`, navigate to a `ride-complete.tsx` screen showing:

```
┌────────────────────────────────┐
│           ✅                    │
│    Job Complete!                │
│                                │
│    You Earned: ₹72             │
│    (₹85 fare − ₹13 commission) │
│                                │
│    Cash collected: ₹85         │
│                                │
│    Rate your passenger:        │
│    ★ ★ ★ ★ ★                   │
│                                │
│    [  Back to Home  ]          │
└────────────────────────────────┘
```

### 5.3 Backend Changes

#### `ratings.routes.ts` — POST /ratings

The rating table and policy already exist (migration 001). Add a Fastify route:

```typescript
app.post("/ratings", { preHandler: [authGuard] }, async (request, reply) => {
  const userId = request.user!.id;
  const body = RatingSchema.parse(request.body);

  // Verify caller is a participant
  const { data: ride } = await supabaseAdmin
    .from("rides")
    .select("customer_id, driver_id, status")
    .eq("id", body.ride_id)
    .eq("status", "completed")
    .single();

  if (!ride) return reply.status(404).send({ error: "Ride not found or not completed" });

  const by = ride.customer_id === userId ? "customer" : ride.driver_id === userId ? "driver" : null;
  if (!by) return reply.status(403).send({ error: "Not a participant" });

  // Insert rating
  await supabaseAdmin.from("ratings").insert({
    ride_id: body.ride_id,
    by,
    stars: body.stars,
    comment: body.comment,
  });

  // Update driver's rolling average if rated by customer
  if (by === "customer") {
    await supabaseAdmin.rpc("update_driver_rating", { p_driver_id: ride.driver_id, p_stars: body.stars });
    // Or manual: UPDATE drivers SET rating_sum = rating_sum + stars, rating_count = rating_count + 1
  }

  return reply.send({ success: true });
});
```

### 5.4 Manual Verification — Phase 5

1. **Complete a trip** → verify navigation to the summary screen (not Alert)
2. **Customer app** → tap 4 stars → verify rating is inserted in `ratings` table
3. **Driver app** → tap 5 stars → verify a second rating row appears
4. **Check `drivers` table** → verify `rating_sum` and `rating_count` updated
5. **Verify no duplicate ratings** → try rating twice → should be rejected

---

## Phase 6 — Cancellation Flows & Edge Cases

> **Goal:** Handle all the "unhappy paths" — driver doesn't show up, customer cancels mid-trip, network drops, app kills.

### 6.1 Driver No-Show Timeout

If the driver accepts but doesn't arrive within 10 minutes, the customer can cancel without penalty. Add a timer on the customer's live ride screen.

### 6.2 Network Reconnection

Both apps already handle reconnection (the driver app's `setupBroadcast` auto-retries, and `AppState` listener reconnects on foreground). Verify these paths work.

### 6.3 Manual Verification — Phase 6

1. **Accept ride → kill driver app** → verify customer can cancel after timeout
2. **Mid-trip → toggle airplane mode** → verify reconnection and status sync
3. **Cancel from customer side** → verify driver gets `cancelled` broadcast

---

## Complete Ride State Machine

```
                    ┌─────────────┐
                    │  requested  │
                    └──────┬──────┘
                           │ driver accepts
                    ┌──────▼──────┐
              ┌─────│  accepted   │─────┐
              │     └──────┬──────┘     │
              │            │ driver     │ cancel
              │            │ arrives    │
              │     ┌──────▼──────┐     │
              │     │  arriving   │─────┤
              │     └──────┬──────┘     │
              │            │ OTP        │
              │            │ verified   │
              │     ┌──────▼──────┐     │
              │     │ in_progress │     │
              │     └──────┬──────┘     │
              │            │ driver     │
              │            │ completes  │
              │     ┌──────▼──────┐     │
              │     │  completed  │     │
              │     └─────────────┘     │
              │                         │
              │     ┌─────────────┐     │
              └────►│  cancelled  │◄────┘
                    └─────────────┘
```

---

## File Change Summary

### Backend (`riksho_backend`)

| File | Action | Phase |
|------|--------|-------|
| `migrations/018_ride_otp.sql` | **NEW** — Add `ride_otp` column | 1 |
| `src/modules/rides/rides.routes.ts` | **MODIFY** — Generate OTP, add `/verify-otp`, block `/start` | 1, 2 |
| `src/modules/matching/matching.service.ts` | **MODIFY** — Include customer name in offer | 2 |
| `src/modules/drivers/drivers.routes.ts` | **MODIFY** — Broadcast location to ride channel | 3 |
| `src/modules/ratings/ratings.routes.ts` | **NEW** — POST /ratings endpoint | 5 |
| `src/index.ts` | **MODIFY** — Register ratings routes | 5 |

### Customer App (`riksho_android`)

| File | Action | Phase |
|------|--------|-------|
| `app/(root)/searching.tsx` | **MODIFY** — Pass OTP to ride screen | 1 |
| `app/(root)/ride/[rideId].tsx` | **MODIFY** — Show OTP, driver info card, driver marker | 1, 2, 3 |
| `components/Map.tsx` | **MODIFY** — Accept and render driver location marker | 3 |
| `app/(root)/ride-complete.tsx` | **NEW** — Ride summary + rating screen | 5 |

### Driver App (`riksho_partner_android`)

| File | Action | Phase |
|------|--------|-------|
| `components/OfferCard.tsx` | **MODIFY** — Show customer name, richer layout | 2 |
| `app/(root)/ride/[rideId].tsx` | **MODIFY** — OTP input, arrival detection, summary nav | 1, 4 |
| `app/(root)/ride-complete.tsx` | **NEW** — Trip summary + rating screen | 5 |

---

## Implementation Order & Dependencies

```
Phase 1 (OTP)        ──► Phase 2 (Rich Info)   ──► Phase 3 (Live Location)
     │                         │                          │
     │                         │                          │
     ▼                         ▼                          ▼
  VERIFY 1               VERIFY 2                   VERIFY 3
                                                          │
                                              Phase 4 (Arrival Detection)
                                                          │
                                                          ▼
                                                     VERIFY 4
                                                          │
                                              Phase 5 (Completion + Rating)
                                                          │
                                                          ▼
                                                     VERIFY 5
                                                          │
                                              Phase 6 (Edge Cases)
                                                          │
                                                          ▼
                                                     VERIFY 6
```

> **Critical rule:** Do NOT proceed to the next phase until the current phase's manual verification passes completely. Each phase is designed to be independently deployable and testable.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| OTP leak via broadcast | OTP is NEVER included in driver-facing broadcasts. Only the customer receives it via the `POST /rides` response. |
| Race condition on accept | Already handled — atomic `UPDATE ... WHERE status='requested' AND driver_id IS NULL` ensures first-writer-wins. |
| Stale driver locations | Already handled — `findNearbyDrivers` filters `updated_at > 2 minutes ago`. |
| Network drops during OTP entry | The OTP is stored in the DB. If the driver app reconnects, they can re-enter it. The customer's OTP is passed via route params and persists in the component state. |
| Multiple ride requests | The customer's `searching.tsx` already has a 60s timeout. If no driver accepts, the ride stays `requested` and can be cancelled. |

---

## Estimated Effort

| Phase | Effort | Files Changed |
|-------|--------|---------------|
| Phase 1 — OTP | ~2 hours | 5 files |
| Phase 2 — Rich Info | ~1.5 hours | 4 files |
| Phase 3 — Live Location | ~2 hours | 3 files |
| Phase 4 — Arrival Detection | ~30 min | 1 file |
| Phase 5 — Summary + Rating | ~2 hours | 5 files |
| Phase 6 — Edge Cases | ~1 hour | Testing only |
| **Total** | **~9 hours** | **~15 files** |

---

> **Next step:** Run `Phase 1` after this document is reviewed and approved. Start with the migration, then backend, then both apps. Test with two emulators side by side.
