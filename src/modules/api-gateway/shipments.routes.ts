import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { apiKeyGuard } from "../../common/apikey.guard.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { calculateFare } from "../fares/fares.config.js";

const ShipmentRequestSchema = z.object({
  idempotency_key: z.string().min(1),
  origin_lat: z.number().min(-90).max(90),
  origin_lng: z.number().min(-180).max(180),
  origin_address: z.string().min(1),
  dest_lat: z.number().min(-90).max(90),
  dest_lng: z.number().min(-180).max(180),
  dest_address: z.string().min(1),
  vehicle_type: z.enum(["tempo", "mini_truck", "truck"]),
  cargo_weight_kg: z.number().min(1),
});

export async function shipmentsRoutes(app: FastifyInstance) {
  app.post("/api/v1/shipments", { preHandler: [apiKeyGuard] }, async (request, reply) => {
    const businessId = request.apiUser!.business_id;
    const body = ShipmentRequestSchema.parse(request.body);

    // 1. Check for idempotency — the key is globally UNIQUE (migration 006),
    //    so a match means this exact request was already processed.
    const { data: existingJob } = await supabaseAdmin
      .from("rides")
      .select("id, status, business_id")
      .eq("idempotency_key", body.idempotency_key)
      .maybeSingle();

    if (existingJob) {
      // Guard against key reuse across businesses.
      if (existingJob.business_id && existingJob.business_id !== businessId) {
        return reply.status(409).send({ error: "idempotency_key already used by another account" });
      }
      return reply.send({
        message: "Shipment already exists",
        ride_id: existingJob.id,
        status: existingJob.status,
      });
    }

    // 2. Calculate Distance
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json() as { routes?: Array<{ distance: number; duration: number }> };
    
    if (!routeData.routes || routeData.routes.length === 0) {
      return reply.status(400).send({ error: "Could not calculate route" });
    }
    const route = routeData.routes[0];

    // 3. Pricing - Check if business has a contract for this vehicle
    let fareEstimate = calculateFare(body.vehicle_type as any, route.distance, route.duration);
    
    const { data: contract } = await supabaseAdmin
      .from("contracts")
      .select("*")
      .eq("business_id", businessId)
      .eq("vehicle_type", body.vehicle_type)
      .maybeSingle();

    if (contract) {
      // Contract pricing logic
      const distanceKm = route.distance / 1000;
      const durationMin = route.duration / 60;
      let cost = contract.base_fare + (distanceKm * contract.per_km) + (durationMin * contract.per_min);
      fareEstimate = Math.max(cost, contract.minimum_fare);
    }

    // 4. Create Job
    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .insert({
        origin_lat: body.origin_lat,
        origin_lng: body.origin_lng,
        origin_address: body.origin_address,
        dest_lat: body.dest_lat,
        dest_lng: body.dest_lng,
        dest_address: body.dest_address,
        vehicle_type: body.vehicle_type,
        service_type: "fleet",
        cargo_weight_kg: body.cargo_weight_kg,
        distance_m: Math.round(route.distance),
        duration_s: Math.round(route.duration),
        fare_estimate: fareEstimate,
        status: "requested",
        payment_method: "invoice", // B2B API shipments settle via monthly invoice
        payment_status: "pending",
        idempotency_key: body.idempotency_key,
        business_id: businessId, // owner (customer_id is null for API shipments)
      })
      .select()
      .single();

    if (error) {
      // 23505 = unique violation → a concurrent request with the same
      // idempotency_key won the race. Return that job instead of erroring.
      if ((error as any).code === "23505") {
        const { data: raced } = await supabaseAdmin
          .from("rides")
          .select("id, status")
          .eq("idempotency_key", body.idempotency_key)
          .maybeSingle();
        if (raced) {
          return reply.send({ message: "Shipment already exists", ride_id: raced.id, status: raced.status });
        }
      }
      return reply.status(500).send({ error: "Failed to create shipment" });
    }

    // 5. Broadcast to drivers
    findNearbyDrivers(body.origin_lat, body.origin_lng, body.vehicle_type, ride.id, "fleet", body.cargo_weight_kg).catch(() => {});

    return reply.status(201).send({
      message: "Shipment created successfully",
      ride_id: ride.id,
      status: ride.status,
      fare_estimate: fareEstimate,
    });
  });

  app.get("/api/v1/shipments/:id", { preHandler: [apiKeyGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    
    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .select("id, status, driver_id, origin_address, dest_address, fare_estimate")
      .eq("id", id)
      .single();

    if (error || !ride) {
      return reply.status(404).send({ error: "Shipment not found" });
    }

    return reply.send({ shipment: ride });
  });
}
