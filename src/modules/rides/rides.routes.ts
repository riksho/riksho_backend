import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { calculateFare, type VehicleType } from "../fares/fares.config.js";
import { findNearbyDrivers } from "../matching/matching.service.js";

export async function ridesRoutes(app: FastifyInstance) {
  // POST /rides — Request a ride
  app.post("/rides", { preHandler: [authGuard] }, async (request, reply) => {
    const customerId = request.user!.id;
    const body = request.body as {
      origin_lat: number;
      origin_lng: number;
      origin_address: string;
      dest_lat: number;
      dest_lng: number;
      dest_address: string;
      vehicle_type: VehicleType;
    };

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
        distance_m: Math.round(route.distance),
        duration_s: Math.round(route.duration),
        fare_estimate: fareEstimate,
        payment_method: "cash",
        payment_status: "pending",
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to create ride", details: error.message });
    }

    // Log ride event
    await supabaseAdmin.from("ride_events").insert({
      ride_id: ride.id,
      type: "requested",
      payload: { customer_id: customerId, vehicle_type: body.vehicle_type },
    });

    // Find nearby drivers and notify them (async — don't await)
    findNearbyDrivers(body.origin_lat, body.origin_lng, body.vehicle_type, ride.id).catch(() => {});

    return reply.status(201).send({
      ride_id: ride.id,
      status: ride.status,
      fare_estimate: fareEstimate,
      distance_km: +(route.distance / 1000).toFixed(1),
      duration_min: Math.round(route.duration / 60),
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

  // POST /rides/:id/cancel — Cancel a ride
  app.post("/rides/:id/cancel", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const body = request.body as { reason?: string };

    // Atomic: only cancel if in a cancellable state
    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: body.reason || null,
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
      payload: { cancelled_by: userId, reason: body.reason },
    });

    return reply.send({ status: "cancelled" });
  });

  // POST /rides/:id/accept — Driver accepts (atomic claim)
  app.post("/rides/:id/accept", { preHandler: [authGuard] }, async (request, reply) => {
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

    return reply.send({ status: "accepted", ride: data });
  });

  // POST /rides/:id/arrived — Driver arrived at pickup
  app.post("/rides/:id/arrived", { preHandler: [authGuard] }, async (request, reply) => {
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

    return reply.send({ status: "arriving" });
  });

  // POST /rides/:id/start — Start the trip
  app.post("/rides/:id/start", { preHandler: [authGuard] }, async (request, reply) => {
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

    return reply.send({ status: "in_progress" });
  });

  // POST /rides/:id/complete — Complete the trip
  app.post("/rides/:id/complete", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const body = request.body as { fare_final?: number; payment_method?: string };

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("fare_estimate")
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "in_progress")
      .single();

    if (!ride) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        status: "completed",
        fare_final: body.fare_final || ride.fare_estimate,
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

    // Set driver back to online
    await supabaseAdmin.from("drivers").update({ status: "online" }).eq("id", driverId);

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "completed",
      payload: { fare_final: data.fare_final },
    });

    return reply.send({ status: "completed", fare_final: data.fare_final });
  });
}
