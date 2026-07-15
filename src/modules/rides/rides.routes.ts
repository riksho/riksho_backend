import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { logger } from "../../common/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { calculateFare, type VehicleType } from "../fares/fares.config.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { broadcastRideStatus, broadcastOrderStatus } from "../matching/broadcast.service.js";
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
        distance_m: Math.round(route.distance),
        duration_s: Math.round(route.duration),
        fare_estimate: fareEstimate,
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

    // Broadcast to customer: driver accepted
    broadcastRideStatus(id, "accepted", { driver_id: driverId });
    notifyBusinessWebhook(id, "accepted", { driver_id: driverId }).catch(() => {});

    return reply.send({ status: "accepted", ride: data });
  });

  // POST /rides/:id/arrived — Driver arrived at pickup
  app.post("/rides/:id/arrived", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "arriving" })
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

    return reply.send({ status: "arriving" });
  });

  // POST /rides/:id/start — Start the trip
  app.post("/rides/:id/start", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

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

    return reply.send({ status: "in_progress" });
  });

  // POST /rides/:id/complete — Complete the trip (server-side fare recompute)
  app.post("/rides/:id/complete", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const body = RideCompleteSchema.parse(request.body ?? {});

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("fare_estimate, distance_m, duration_s, vehicle_type")
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "in_progress")
      .single();

    if (!ride) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    // Server-side fare recompute: clamp driver-submitted fare to ±20% of estimate
    let fareFinal = ride.fare_estimate;
    if (body.fare_final) {
      const maxAllowed = ride.fare_estimate * 1.2;
      const minAllowed = ride.fare_estimate * 0.8;
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

    return reply.send({ status: "completed", fare_final: fareFinal });
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
