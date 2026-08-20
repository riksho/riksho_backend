import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { BusinessRegisterSchema } from "../../common/schemas.js";
import { calculateFare, type VehicleType } from "../fares/fares.config.js";
import { findNearbyDrivers } from "../matching/matching.service.js";

const BusinessJobSchema = z.object({
  origin_lat: z.number().min(-90).max(90),
  origin_lng: z.number().min(-180).max(180),
  origin_address: z.string().min(1),
  dest_lat: z.number().min(-90).max(90),
  dest_lng: z.number().min(-180).max(180),
  dest_address: z.string().min(1),
  vehicle_type: z.enum(["tempo", "mini_truck", "truck"]),
  cargo_weight_kg: z.number().min(1),
});

export default async function businessRoutes(app: FastifyInstance) {
  // POST /business/register — Upgrade user account to business
  app.post("/business/register", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const user = (request as any).user;
    const customerId = user.id;

    const body = BusinessRegisterSchema.parse(request.body);

    // 1. Insert into businesses
    const { data: business, error: businessError } = await supabaseAdmin
      .from("businesses")
      .insert({
        owner_user_id: customerId,
        name: body.name,
        gstin: body.gstin,
        address: body.address,
        city: body.city,
        tier: body.tier || null,
      })
      .select()
      .single();

    if (businessError) {
      if (businessError.code === "23505") { // unique violation if we had one
        return reply.status(400).send({ error: "Business already registered for this user" });
      }
      return reply.status(500).send({ error: "Failed to register business" });
    }

    // 2. Upgrade user account_type
    const { error: userError } = await supabaseAdmin
      .from("users")
      .update({ account_type: "business" })
      .eq("id", customerId);

    if (userError) {
      return reply.status(500).send({ error: "Failed to upgrade user account type" });
    }

    return reply.status(201).send({
      message: "Business registered successfully",
      business,
    });
  });

  // GET /business/me — Get business profile
  app.get("/business/me", { preHandler: [authGuard, requireRole("customer", "business_owner", "admin")] }, async (request, reply) => {
    const user = (request as any).user;
    const customerId = user.id;

    const { data: business, error } = await supabaseAdmin
      .from("businesses")
      .select("*")
      .eq("owner_user_id", customerId)
      .single();

    if (error || !business) {
      return reply.status(404).send({ error: "Business not found" });
    }

    return reply.send({ business });
  });

  // Helper: resolve the caller's business row (or null).
  async function getBusinessForUser(userId: string) {
    const { data } = await supabaseAdmin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", userId)
      .single();
    return data;
  }

  // POST /business/jobs — Create a fleet job attributed to the business.
  // This is the app-facing counterpart to the /api/v1/shipments API path;
  // it guarantees business_id is attached (unlike the generic /rides route).
  app.post("/business/jobs", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const userId = request.user!.id;
    const business = await getBusinessForUser(userId);
    if (!business) {
      return reply.status(403).send({ error: "No business account. Register a business first." });
    }

    const body = BusinessJobSchema.parse(request.body);

    // Route + fare
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
    let distanceM = 0, durationS = 0;
    try {
      const routeRes = await fetch(osrmUrl);
      const routeData = await routeRes.json() as { routes?: Array<{ distance: number; duration: number }> };
      if (routeData.routes?.length) {
        distanceM = Math.round(routeData.routes[0].distance);
        durationS = Math.round(routeData.routes[0].duration);
      }
    } catch (err) {
      logger.warn({ err }, "OSRM routing failed for business job; proceeding with 0 distance");
    }

    const fareEstimate = calculateFare(body.vehicle_type as VehicleType, distanceM, durationS);

    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .insert({
        business_id: business.id,
        service_type: "fleet",
        status: "requested",
        vehicle_type: body.vehicle_type,
        origin_lat: body.origin_lat,
        origin_lng: body.origin_lng,
        origin_address: body.origin_address,
        dest_lat: body.dest_lat,
        dest_lng: body.dest_lng,
        dest_address: body.dest_address,
        cargo_weight_kg: body.cargo_weight_kg,
        distance_m: distanceM,
        duration_s: durationS,
        fare_estimate: fareEstimate,
        payment_method: "invoice",
        payment_status: "pending",
      })
      .select()
      .single();

    if (error || !ride) {
      logger.error({ err: error?.message }, "Failed to create business fleet job");
      return reply.status(500).send({ error: "Failed to create fleet job" });
    }

    findNearbyDrivers(body.origin_lat, body.origin_lng, body.vehicle_type, ride.id, "fleet", body.cargo_weight_kg).catch(() => {});

    return reply.status(201).send({ ride_id: ride.id, status: ride.status, fare_estimate: fareEstimate });
  });

  // GET /business/jobs — This business's fleet job history.
  app.get("/business/jobs", { preHandler: [authGuard, requireRole("customer", "business_owner", "admin")] }, async (request, reply) => {
    const userId = request.user!.id;
    const business = await getBusinessForUser(userId);
    if (!business) {
      return reply.status(403).send({ error: "No business account." });
    }

    const { data: jobs, error } = await supabaseAdmin
      .from("rides")
      .select("*")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return reply.status(500).send({ error: "Failed to fetch jobs" });
    return reply.send({ jobs: jobs || [] });
  });

  // ─── Portal-specific endpoints ─────────────────────────────────────

  // Business accounts keep role='customer' (only account_type flips to 'business');
  // ownership is enforced via getBusinessForUser below, which returns null for
  // non-business callers so the endpoints degrade to empty results rather than 403.
  // 'business_owner' is accepted too for forward-compat if that role is ever minted.
  const portalGuard = { preHandler: [authGuard, requireRole("customer", "business_owner", "admin")] };

  // GET /business/portal/me — Portal identity check (returns role + business info)
  app.get("/business/portal/me", portalGuard, async (request, reply) => {
    const userId = request.user!.id;
    const business = await getBusinessForUser(userId);
    const isAdmin = request.user!.role === "admin";

    if (!business && !isAdmin) {
      return reply.send({
        id: userId,
        email: request.user!.email,
        phone: request.user!.phone,
        role: "unregistered",
        business: null,
      });
    }

    return reply.send({
      id: userId,
      email: request.user!.email,
      phone: request.user!.phone,
      role: isAdmin ? "admin" : "business_owner",
      business: business || null,
    });
  });

  // GET /business/portal/stats — Real dashboard numbers
  app.get("/business/portal/stats", portalGuard, async (request, reply) => {
    const userId = request.user!.id;
    const business = await getBusinessForUser(userId);
    if (!business) {
      return reply.send({ active: 0, completed: 0, scheduled: 0, spend: 0 });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [activeRes, completedRes, scheduledRes, spendRes] = await Promise.all([
      supabaseAdmin.from("rides")
        .select("id", { count: "exact", head: true })
        .eq("business_id", business.id)
        .in("status", ["requested", "accepted", "arriving", "in_progress"]),
      supabaseAdmin.from("rides")
        .select("id", { count: "exact", head: true })
        .eq("business_id", business.id)
        .eq("status", "completed")
        .gte("completed_at", monthStart),
      supabaseAdmin.from("scheduled_jobs")
        .select("id", { count: "exact", head: true })
        .eq("business_id", business.id)
        .eq("is_active", true),
      supabaseAdmin.from("rides")
        .select("fare_final")
        .eq("business_id", business.id)
        .eq("status", "completed")
        .gte("completed_at", monthStart),
    ]);

    const totalSpend = (spendRes.data || []).reduce((sum: number, r: any) => sum + (r.fare_final || 0), 0);

    return reply.send({
      active: activeRes.count ?? 0,
      completed: completedRes.count ?? 0,
      scheduled: scheduledRes.count ?? 0,
      spend: totalSpend,
    });
  });

  // GET /business/portal/shipments — Real shipments list
  app.get("/business/portal/shipments", portalGuard, async (request, reply) => {
    const userId = request.user!.id;
    const business = await getBusinessForUser(userId);
    if (!business) {
      return reply.send({ shipments: [] });
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .select("id, origin_address, dest_address, vehicle_type, status, fare_estimate, fare_final, cargo_weight_kg, created_at, completed_at, service_type, driver_id")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return reply.status(500).send({ error: "Failed to fetch shipments" });
    return reply.send({ shipments: data || [] });
  });

  // POST /business/portal/shipments/bulk — Bulk upload shipments
  app.post("/business/portal/shipments/bulk", portalGuard, async (request, reply) => {
    const userId = request.user!.id;
    const business = await getBusinessForUser(userId);
    if (!business) {
      return reply.status(403).send({ error: "No business account." });
    }

    const { shipments } = request.body as { shipments: any[] };
    if (!Array.isArray(shipments) || shipments.length === 0) {
      return reply.status(400).send({ error: "Invalid or empty shipments array" });
    }

    const newRides = [];
    for (const s of shipments) {
      // In a real prod env, we'd geocode the address here or on the frontend.
      // For this POC, we'll use placeholder coordinates if none are provided.
      const originLat = s.origin_lat || 28.6139;
      const originLng = s.origin_lng || 77.2090;
      const destLat = s.dest_lat || 28.5355;
      const destLng = s.dest_lng || 77.3910;
      const vehicleType = s.vehicle_type || "mini_truck";
      
      const distanceM = 15000; // Mock 15km for bulk simple insert
      const durationS = 3600; // Mock 1h
      const fareEstimate = calculateFare(vehicleType as VehicleType, distanceM, durationS);

      newRides.push({
        business_id: business.id,
        service_type: "fleet",
        status: "requested",
        vehicle_type: vehicleType,
        origin_lat: originLat,
        origin_lng: originLng,
        origin_address: s.origin_address || "Unknown Origin",
        dest_lat: destLat,
        dest_lng: destLng,
        dest_address: s.dest_address || "Unknown Destination",
        cargo_weight_kg: Number(s.cargo_weight_kg) || 100,
        distance_m: distanceM,
        duration_s: durationS,
        fare_estimate: fareEstimate,
        payment_method: "invoice",
        payment_status: "pending",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .insert(newRides)
      .select();

    if (error) {
      logger.error({ err: error?.message }, "Failed to bulk create fleet jobs");
      return reply.status(500).send({ error: "Failed to process bulk upload" });
    }

    // Trigger driver discovery for all
    if (data) {
      for (const ride of data) {
        findNearbyDrivers(ride.origin_lat, ride.origin_lng, ride.vehicle_type, ride.id, "fleet", ride.cargo_weight_kg).catch(() => {});
      }
    }

    return reply.status(201).send({ message: `Successfully created ${data?.length || 0} shipments`, count: data?.length });
  });
}

