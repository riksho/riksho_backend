import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { DriverLocationSchema, DriverRegisterSchema } from "../../common/schemas.js";

export async function driversRoutes(app: FastifyInstance) {
  // POST /drivers/online — Go online (drivers only)
  app.post("/drivers/online", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;

    const { error } = await supabaseAdmin
      .from("drivers")
      .update({ status: "online", updated_at: new Date().toISOString() })
      .eq("id", driverId);

    if (error) {
      return reply.status(500).send({ error: "Failed to go online" });
    }

    return reply.send({ status: "online" });
  });

  // POST /drivers/offline — Go offline (drivers only)
  app.post("/drivers/offline", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;

    const { error } = await supabaseAdmin
      .from("drivers")
      .update({ status: "offline", updated_at: new Date().toISOString() })
      .eq("id", driverId);

    if (error) {
      return reply.status(500).send({ error: "Failed to go offline" });
    }

    // Clear stale location on offline
    await supabaseAdmin
      .from("driver_locations")
      .delete()
      .eq("driver_id", driverId);

    return reply.send({ status: "offline" });
  });

  // POST /drivers/location — Update current location (drivers only, Zod-validated)
  app.post("/drivers/location", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { lat, lng } = DriverLocationSchema.parse(request.body);

    const { error } = await supabaseAdmin
      .from("driver_locations")
      .upsert(
        {
          driver_id: driverId,
          lat,
          lng,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "driver_id" }
      );

    if (error) {
      return reply.status(500).send({ error: "Failed to update location" });
    }

    return reply.send({ success: true });
  });

  // GET /drivers/earnings — Earnings summary (drivers only)
  app.get("/drivers/earnings", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { range } = request.query as { range?: string };

    let query = supabaseAdmin
      .from("rides")
      .select("fare_final, completed_at, payment_method")
      .eq("driver_id", driverId)
      .eq("status", "completed")
      .not("fare_final", "is", null);

    // Filter by date range
    if (range === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      query = query.gte("completed_at", today.toISOString());
    } else if (range === "week") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      weekAgo.setHours(0, 0, 0, 0);
      query = query.gte("completed_at", weekAgo.toISOString());
    }

    const { data: rides, error } = await query;

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch earnings" });
    }

    const totalEarnings = (rides || []).reduce((sum, r) => sum + (r.fare_final || 0), 0);
    const tripCount = (rides || []).length;
    const cashTrips = (rides || []).filter((r) => r.payment_method === "cash").length;

    return reply.send({
      total_earnings: totalEarnings,
      trip_count: tripCount,
      cash_trips: cashTrips,
      online_trips: tripCount - cashTrips,
      range: range || "all",
    });
  });

  // GET /drivers/profile — Get driver profile (drivers only)
  app.get("/drivers/profile", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;

    const { data, error } = await supabaseAdmin
      .from("drivers")
      .select("*, vehicles(*)")
      .eq("id", driverId)
      .single();

    if (error) {
      return reply.status(404).send({ error: "Driver profile not found" });
    }

    return reply.send(data);
  });

  // POST /drivers/register — Register as a driver (onboarding)
  // No role guard — any authenticated user can register as a driver
  app.post("/drivers/register", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const body = DriverRegisterSchema.parse(request.body);

    // Create driver profile (verification_status = pending by default from migration)
    const { error: driverError } = await supabaseAdmin.from("drivers").upsert({
      id: driverId,
      name: body.name,
      phone: request.user!.phone,
      license_no: body.license_no,
      status: "offline",
      rating: 5.0,
      is_verified: false,
      verification_status: "pending",
      created_at: new Date().toISOString(),
    });

    if (driverError) {
      return reply.status(500).send({ error: "Failed to create driver" });
    }

    // Create vehicle
    const { error: vehicleError } = await supabaseAdmin.from("vehicles").insert({
      driver_id: driverId,
      type: body.vehicle_type,
      plate: body.plate,
      model: body.model,
      seats: body.seats || (body.vehicle_type === "bike" ? 1 : body.vehicle_type === "auto" ? 3 : 4),
    });

    if (vehicleError) {
      return reply.status(500).send({ error: "Failed to create vehicle" });
    }

    // Update user role metadata + server-side role column
    await supabaseAdmin.auth.admin.updateUserById(driverId, {
      user_metadata: { role: "driver" },
    });

    // Also set role in users table (server-authoritative)
    await supabaseAdmin
      .from("users")
      .update({ role: "driver" })
      .eq("id", driverId);

    return reply.status(201).send({ success: true, message: "Driver registered. Pending verification." });
  });
}
