import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import * as crypto from "node:crypto";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { logger } from "../../common/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import {
  calculateFare,
  clampOfferedFare,
  effectiveFare,
  type VehicleType,
} from "../fares/fares.config.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { broadcastRideStatus, broadcastOrderStatus } from "../matching/broadcast.service.js";
import { sendPush } from "../notifications/push.service.js";
import { fireWebhook } from "../notifications/webhook.service.js";
import {
  RideRequestSchema,
  RideCancelSchema,
  RideCompleteSchema,
} from "../../common/schemas.js";

export async function ridesRoutes(app: FastifyInstance) {
  // POST /rides — Request a ride (customers only)
  app.post("/rides", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const customerId = request.user!.id;
    const body = RideRequestSchema.parse(request.body);

    // Calculate route via OSRM
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json() as { routes?: Array<{ distance: number; duration: number }> };

    if (!routeData.routes || routeData.routes.length === 0) {
      return reply.status(400).send({ error: "Could not calculate route" });
    }

    const route = routeData.routes[0];
    const fareEstimate = calculateFare(body.vehicle_type, route.distance, route.duration);

    // Honour the customer's offered fare from the find-ride stepper (fix A3), but
    // never trust it: clamp to 0.8x–2.0x of our own estimate. Bidding is a "move"
    // concept only — fleet is contract-priced and quick is fee-priced, so we ignore
    // any offered_fare on those and let them settle against fare_estimate.
    const offeredFare =
      body.offered_fare !== undefined && body.service_type === "move"
        ? clampOfferedFare(body.offered_fare, fareEstimate)
        : null;

    if (offeredFare !== null && offeredFare !== Math.round(body.offered_fare!)) {
      logger.info(
        { customerId, requested: body.offered_fare, clamped: offeredFare, fareEstimate },
        "Offered fare clamped to allowed band"
      );
    }

    // Create ride record
    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .insert({
        customer_id: customerId,
        status: "requested",
        vehicle_type: body.vehicle_type,
        origin_lat: body.origin_lat,
        origin_lng: body.origin_lng,
        origin_address: body.origin_address,
        dest_lat: body.dest_lat,
        dest_lng: body.dest_lng,
        dest_address: body.dest_address,
        service_type: body.service_type,
        cargo_weight_kg: body.cargo_weight_kg,
        duration_s: Math.round(route.duration),
        fare_estimate: fareEstimate,
        offered_fare: offeredFare,
        ride_otp: body.service_type === "move" ? crypto.randomInt(1000, 10000).toString() : null,
        payment_method: "cash",
        payment_status: "pending",
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to create ride" });
    }

    // Log ride event
    await supabaseAdmin.from("ride_events").insert({
      ride_id: ride.id,
      type: "requested",
      payload: { customer_id: customerId, vehicle_type: body.vehicle_type, service_type: body.service_type },
    });

    // Find nearby drivers and notify them (async — don't await)
    findNearbyDrivers(body.origin_lat, body.origin_lng, body.vehicle_type, ride.id, body.service_type, body.cargo_weight_kg).catch(() => {});

    return reply.status(201).send({
      ride_id: ride.id,
      status: ride.status,
      fare_estimate: fareEstimate,
      // Echo the *clamped* value so the customer app can correct its display if
      // the stepper went outside the allowed band, rather than showing a fare the
      // server never accepted.
      offered_fare: offeredFare,
      distance_km: +(route.distance / 1000).toFixed(1),
      duration_min: Math.round(route.duration / 60),
    });
  });

  // POST /rides/estimate — Get fare estimate (customers only)
  app.post("/rides/estimate", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const { RideEstimateSchema } = await import("../../common/schemas.js");
    const body = RideEstimateSchema.parse(request.body);

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json() as { routes?: Array<{ distance: number; duration: number }> };

    if (!routeData.routes || routeData.routes.length === 0) {
      return reply.status(400).send({ error: "Could not calculate route" });
    }

    const route = routeData.routes[0];
    const distanceKm = +(route.distance / 1000).toFixed(1);
    const durationMin = Math.round(route.duration / 60);

    // Return estimates for all vehicle types so the customer can pick
    const estimates = {
      bike: calculateFare("bike", route.distance, route.duration),
      auto: calculateFare("auto", route.distance, route.duration),
      e_rickshaw: calculateFare("e_rickshaw", route.distance, route.duration),
      car: calculateFare("car", route.distance, route.duration),
    };

    return reply.send({
      distance_km: distanceKm,
      duration_min: durationMin,
      estimates,
      // Also return the specific type if requested
      fare_estimate: estimates[body.vehicle_type],
      vehicle_type: body.vehicle_type,
    });
  });

  // GET /rides/:id — Get ride details
  app.get("/rides/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .select("*, ride_events(*)")
      .eq("id", id)
      .single();

    if (error || !ride) {
      return reply.status(404).send({ error: "Ride not found" });
    }

    // Only allow the ride's customer or assigned driver to see it
    if (ride.customer_id !== userId && ride.driver_id !== userId) {
      return reply.status(403).send({ error: "Not authorized to view this ride" });
    }

    // Never leak OTP to the driver (B2)
    if (ride.customer_id !== userId) {
      delete ride.ride_otp;
    }

    // B6: Append customer name and phone so driver app can call the customer
    if (ride.driver_id === userId || request.user!.role === "driver") {
      const { data: customer } = await supabaseAdmin
        .from("users")
        .select("name, phone")
        .eq("id", ride.customer_id)
        .single();
        
      if (customer) {
        ride.customer_phone = customer.phone;
        ride.customer_name = customer.name || "Customer";
      }
    }

    // Append driver info if customer is calling
    if (ride.customer_id === userId && ride.driver_id) {
      const { data: driverInfo } = await supabaseAdmin
        .from("drivers")
        .select("name, phone, rating, vehicles(type, plate, model)")
        .eq("id", ride.driver_id)
        .single();
        
      if (driverInfo) {
        const v = Array.isArray(driverInfo.vehicles) ? driverInfo.vehicles[0] : driverInfo.vehicles;
        ride.driver_name = driverInfo.name || "Driver";
        ride.driver_phone = driverInfo.phone;
        ride.driver_rating = driverInfo.rating;
        ride.vehicle_type = v?.type;
        ride.vehicle_plate = v?.plate;
        ride.vehicle_model = v?.model;
      }
    }

    return reply.send(ride);
  });

  // GET /rides — Ride history
  app.get("/rides", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const role = request.user!.role;

    let query = supabaseAdmin
      .from("rides")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (role === "driver") {
      query = query.eq("driver_id", userId);
    } else {
      query = query.eq("customer_id", userId);
    }

    const { data, error } = await query;

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch rides" });
    }

    return reply.send(data || []);
  });

  // POST /rides/:id/cancel — Cancel a ride (participant check)
  app.post("/rides/:id/cancel", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const body = RideCancelSchema.parse(request.body ?? {});

    // First: verify the caller is a participant
    const { data: existingRide } = await supabaseAdmin
      .from("rides")
      .select("customer_id, driver_id, status")
      .eq("id", id)
      .single();

    if (!existingRide) {
      return reply.status(404).send({ error: "Ride not found" });
    }

    if (existingRide.customer_id !== userId && existingRide.driver_id !== userId) {
      return reply.status(403).send({ error: "Not authorized to cancel this ride" });
    }

    // Determine who is cancelling
    const cancelledBy = existingRide.customer_id === userId ? "customer" : "driver";

    // Atomic: only cancel if in a cancellable state
    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: body.reason || null,
        cancelled_by: cancelledBy,
      })
      .eq("id", id)
      .in("status", ["requested", "accepted", "arriving"])
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Ride cannot be cancelled in its current state" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "cancelled",
      payload: { cancelled_by: cancelledBy, reason: body.reason },
    });

    // Broadcast cancellation to the other party
    broadcastRideStatus(id, "cancelled", { cancelled_by: cancelledBy });
    syncQuickOrder(id, "cancelled").catch(() => {});
    notifyBusinessWebhook(id, "cancelled", { cancelled_by: cancelledBy }).catch(() => {});

    return reply.send({ status: "cancelled" });
  });

  // POST /rides/:id/decline — Driver declines the ride
  app.post("/rides/:id/decline", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    // Verify ride is still requested
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("status")
      .eq("id", id)
      .single();

    if (!ride || ride.status !== "requested") {
      // It's not requested anymore (someone else took it or cancelled), just ack
      return reply.send({ status: "ignored" });
    }

    // Insert decline record so matching service can exclude this driver
    await supabaseAdmin
      .from("ride_declines")
      .insert({ ride_id: id, driver_id: driverId })
      .select()
      .single();

    return reply.send({ status: "declined" });
  });

  // POST /rides/:id/accept — Driver accepts (atomic claim)
  app.post("/rides/:id/accept", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    // Atomic: only the first driver to accept wins
    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        driver_id: driverId,
        status: "accepted",
        accepted_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "requested")
      .is("driver_id", null)
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Ride already taken or not available" });
    }

    // Update driver status
    await supabaseAdmin.from("drivers").update({ status: "on_trip" }).eq("id", driverId);

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "accepted",
      payload: { driver_id: driverId },
    });

    // B6: Fetch driver and vehicle info to broadcast to customer
    const { data: driverInfo } = await supabaseAdmin
      .from("drivers")
      .select("name, phone, rating, vehicles(type, plate, model)")
      .eq("id", driverId)
      .single();

    let vType, vPlate, vModel;
    if (driverInfo?.vehicles) {
      const v = Array.isArray(driverInfo.vehicles) ? driverInfo.vehicles[0] : driverInfo.vehicles;
      vType = v?.type;
      vPlate = v?.plate;
      vModel = v?.model;
    }

    const acceptPayload = {
      driver_id: driverId,
      driver_name: driverInfo?.name || "Driver",
      driver_phone: driverInfo?.phone,
      driver_rating: driverInfo?.rating,
      vehicle_type: vType,
      vehicle_plate: vPlate,
      vehicle_model: vModel,
    };

    // Broadcast to customer: driver accepted with full info
    broadcastRideStatus(id, "accepted", acceptPayload);
    notifyBusinessWebhook(id, "accepted", { driver_id: driverId }).catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Driver Accepted",
        body: "Your driver is on the way to the pickup location.",
        data: { ride_id: id, status: "accepted" },
      }).catch(() => {});
    }

    return reply.send({ status: "accepted", ride: data });
  });

  // POST /rides/:id/arrived — Driver arrived at pickup
  app.post("/rides/:id/arrived", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "arriving", arrived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "accepted")
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "arrived", payload: {} });

    // Broadcast to customer: driver arriving
    broadcastRideStatus(id, "arriving", {});
    syncQuickOrder(id, "arriving").catch(() => {});
    notifyBusinessWebhook(id, "arriving").catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Driver Arrived",
        body: "Your driver has arrived at the pickup location.",
        data: { ride_id: id, status: "arriving" },
      }).catch(() => {});
    }

    return reply.send({ status: "arriving" });
  });

  // POST /rides/:id/verify-otp — Driver submits OTP to start trip
  app.post("/rides/:id/verify-otp", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const VerifySchema = z.object({ otp: z.string().length(4) });
    const body = VerifySchema.parse(request.body);

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("ride_otp, otp_attempts, driver_id, status, service_type, customer_id")
      .eq("id", id)
      .single();

    if (!ride || ride.driver_id !== driverId) {
      return reply.status(403).send({ error: "Not authorized" });
    }

    if (ride.status !== "arriving") {
      return reply.status(409).send({ error: "Driver must arrive first" });
    }
    
    if (ride.service_type !== "move") {
      return reply.status(400).send({ error: "OTP verification only applies to passenger rides" });
    }

    if (ride.otp_attempts >= 5) {
      return reply.status(429).send({ error: "Too many failed attempts. Contact support." });
    }

    if (ride.ride_otp !== body.otp) {
      await supabaseAdmin.from("rides").update({ otp_attempts: ride.otp_attempts + 1 }).eq("id", id);
      return reply.status(400).send({ error: "Invalid OTP" });
    }

    // OTP verified — transition to in_progress
    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return reply.status(500).send({ error: "Failed to start ride" });
    }

    await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "started", payload: { otp_verified: true } });

    broadcastRideStatus(id, "in_progress", {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Trip Started",
        body: "Your trip has started.",
        data: { ride_id: id, status: "in_progress" },
      }).catch(() => {});
    }

    return reply.send({ status: "in_progress" });
  });

  // POST /rides/:id/start — Start the trip
  app.post("/rides/:id/start", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    
    // First check if it's a move ride, which MUST use verify-otp instead
    const { data: rideCheck } = await supabaseAdmin
      .from("rides")
      .select("service_type")
      .eq("id", id)
      .single();
      
    if (rideCheck?.service_type === "move") {
      return reply.status(400).send({ error: "OTP verification required for passenger rides. Use /verify-otp" });
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "arriving")
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "started", payload: {} });

    // Broadcast to customer: trip started
    broadcastRideStatus(id, "in_progress", {});
    syncQuickOrder(id, "in_progress").catch(() => {});
    notifyBusinessWebhook(id, "in_progress").catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Trip Started",
        body: "Your trip has started.",
        data: { ride_id: id, status: "in_progress" },
      }).catch(() => {});
    }

    return reply.send({ status: "in_progress" });
  });

  // POST /rides/:id/complete — Complete the trip (server-side fare recompute)
  app.post("/rides/:id/complete", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const body = RideCompleteSchema.parse(request.body ?? {});

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("fare_estimate, offered_fare, distance_m, duration_s, vehicle_type, dest_lat, dest_lng")
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "in_progress")
      .single();

    if (!ride) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    // Server-side location sanity check: verify driver is reasonably close to destination
    try {
      const { data: driverLoc } = await supabaseAdmin
        .from("driver_locations")
        .select("lat, lng")
        .eq("driver_id", driverId)
        .single();
        
      if (driverLoc && ride.dest_lat && ride.dest_lng) {
        const toRad = (value: number) => (value * Math.PI) / 180;
        const R = 6371e3; // meters
        const dLat = toRad(ride.dest_lat - driverLoc.lat);
        const dLng = toRad(ride.dest_lng - driverLoc.lng);
        const lat1 = toRad(driverLoc.lat);
        const lat2 = toRad(ride.dest_lat);

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        // If completing more than 2km away from destination, log an anomaly
        if (distance > 2000) {
          console.warn(`[ANOMALY] Driver ${driverId} completed ride ${id} ${Math.round(distance)}m away from destination.`);
          await supabaseAdmin.from("ride_events").insert({
            ride_id: id,
            type: "anomaly",
            payload: { reason: "early_completion", distance_m: Math.round(distance), driver_lat: driverLoc.lat, driver_lng: driverLoc.lng }
          });
        }
      }
    } catch (err) {
      console.error("Failed to verify driver location at completion:", err);
    }

    // The agreed fare is what the customer offered (already clamped at request
    // time) or, absent a bid, our estimate. Fix A3: this clamp used to be anchored
    // to fare_estimate unconditionally, which would have rejected the very fare
    // the customer agreed to whenever they bid above +20%.
    const agreedFare = effectiveFare(ride);

    // Server-side fare recompute: clamp driver-submitted fare to ±20% of the
    // agreed fare, so a driver cannot inflate the total after the fact.
    let fareFinal = agreedFare;
    if (body.fare_final) {
      const maxAllowed = agreedFare * 1.2;
      const minAllowed = agreedFare * 0.8;
      fareFinal = Math.max(minAllowed, Math.min(maxAllowed, body.fare_final));
      fareFinal = Math.round(fareFinal);
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        status: "completed",
        fare_final: fareFinal,
        payment_method: body.payment_method || "cash",
        payment_status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("driver_id", driverId)
      .select()
      .single();

    if (error || !data) {
      return reply.status(500).send({ error: "Failed to complete ride" });
    }

    // Set driver back to online + increment total_trips (read-update)
    const { data: driverData } = await supabaseAdmin
      .from("drivers")
      .select("total_trips")
      .eq("id", driverId)
      .single();

    await supabaseAdmin
      .from("drivers")
      .update({
        status: "online",
        total_trips: (driverData?.total_trips || 0) + 1,
      })
      .eq("id", driverId);

    // Create earnings ledger entry (graceful — ignore if table missing pre-migration)
    const commission = Math.round(fareFinal * 0.15); // 15% platform fee
    const net = fareFinal - commission;
    const { error: earningsError } = await supabaseAdmin.from("earnings").insert({
      ride_id: id,
      driver_id: driverId,
      gross: fareFinal,
      commission,
      net,
      payment_method: body.payment_method || "cash",
    });
    if (earningsError) {
      logger.warn({ rideId: id, err: earningsError.message }, "Earnings ledger insert failed (non-fatal)");
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "completed",
      payload: { fare_final: fareFinal },
    });

    // Broadcast to customer: trip completed
    broadcastRideStatus(id, "completed", { fare_final: fareFinal });
    syncQuickOrder(id, "completed").catch(() => {});
    notifyBusinessWebhook(id, "completed", { fare_final: fareFinal }).catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Trip Completed",
        body: "You have arrived at your destination.",
        data: { ride_id: id, status: "completed" },
      }).catch(() => {});
    }

    return reply.send({ status: "completed", fare_final: fareFinal });
  });

  // POST /rides/:id/pod — Upload Proof of Delivery (Fleet/Quick)
  app.post("/rides/:id/pod", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const { pod_path } = request.body as any;

    if (!pod_path) {
      return reply.status(400).send({ error: "pod_path is required" });
    }

    // Verify driver owns this ride
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("driver_id, status")
      .eq("id", id)
      .single();

    if (!ride || ride.driver_id !== driverId) {
      return reply.status(403).send({ error: "Not authorized for this ride" });
    }

    const { error } = await supabaseAdmin
      .from("rides")
      .update({ pod_path })
      .eq("id", id);

    if (error) {
      return reply.status(500).send({ error: "Failed to save POD" });
    }

    return reply.send({ success: true });
  });

  // Helper to sync ride state changes to the linked quick_order (if applicable)
  async function syncQuickOrder(rideId: string, status: string) {
    const { data: order } = await supabaseAdmin
      .from("quick_orders")
      .select("id")
      .eq("ride_id", rideId)
      .single();
    
    if (order) {
      let orderStatus = "";
      if (status === "arriving") orderStatus = "rider_arriving_at_store"; // Not heavily used, but informative
      if (status === "in_progress") orderStatus = "out_for_delivery";
      if (status === "completed") orderStatus = "delivered";
      if (status === "cancelled") orderStatus = "delivery_cancelled";

      if (orderStatus) {
        const patch: Record<string, unknown> = { status: orderStatus };
        if (orderStatus === "delivered") patch.delivered_at = new Date().toISOString();
        await supabaseAdmin.from("quick_orders").update(patch).eq("id", order.id);
        broadcastOrderStatus(order.id, orderStatus).catch(() => {});
      }
    }
  }

  // Helper: notify a business's registered webhooks when its fleet job changes state.
  async function notifyBusinessWebhook(rideId: string, status: string, extra: Record<string, unknown> = {}) {
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("business_id, service_type")
      .eq("id", rideId)
      .single();

    if (ride?.service_type === "fleet" && ride.business_id) {
      fireWebhook(ride.business_id, `shipment.${status}`, { ride_id: rideId, status, ...extra }).catch(() => {});
    }
  }
}
