import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { DriverLocationSchema, DriverRegisterSchema, DriverDocumentSchema } from "../../common/schemas.js";

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
      .from("earnings")
      .select("gross, commission, net, payment_method, created_at")
      .eq("driver_id", driverId);

    // Filter by date range
    if (range === "today") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      query = query.gte("created_at", today.toISOString());
    } else if (range === "week") {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      weekAgo.setHours(0, 0, 0, 0);
      query = query.gte("created_at", weekAgo.toISOString());
    } else if (range === "month") {
      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      monthAgo.setHours(0, 0, 0, 0);
      query = query.gte("created_at", monthAgo.toISOString());
    }

    const { data: earnings, error } = await query;

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch earnings" });
    }

    const gross = (earnings || []).reduce((sum, e) => sum + (e.gross || 0), 0);
    const commission = (earnings || []).reduce((sum, e) => sum + (e.commission || 0), 0);
    const net = (earnings || []).reduce((sum, e) => sum + (e.net || 0), 0);
    const tripCount = (earnings || []).length;
    const cashTrips = (earnings || []).filter((e) => e.payment_method === "cash").length;

    return reply.send({
      gross,
      commission,
      net,
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
      partner_type: body.partner_type, // cab_bike | fleet | quick_rider — drives matching
      rating: 5.0,
      is_verified: false,
      verification_status: "pending",
      created_at: new Date().toISOString(),
    });

    if (driverError) {
      return reply.status(500).send({ error: "Failed to create driver" });
    }

    // Create or update vehicle
    const { error: vehicleError } = await supabaseAdmin.from("vehicles").upsert(
      {
        driver_id: driverId,
        type: body.vehicle_type,
        plate: body.plate,
        model: body.model,
        capacity_kg: body.capacity_kg ?? null,
        seats: body.seats || (body.vehicle_type === "bike" ? 1 : body.vehicle_type === "auto" ? 3 : 4),
      },
      { onConflict: "driver_id" }
    );

    if (vehicleError) {
      return reply.status(500).send({ error: "Failed to create vehicle" });
    }

    // Update user role metadata + server-side role column
    await supabaseAdmin.auth.admin.updateUserById(driverId, {
      user_metadata: { role: "driver" },
    });

    // Also set role in users table (server-authoritative). Upsert so the
    // role persists even if the customer profile row doesn't exist yet.
    await supabaseAdmin
      .from("users")
      .upsert({ id: driverId, role: "driver", phone: request.user!.phone }, { onConflict: "id" });

    return reply.status(201).send({ success: true, message: "Driver registered. Pending verification." });
  });

  // POST /drivers/documents — Upload KYC document
  app.post("/drivers/documents", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const body = DriverDocumentSchema.parse(request.body);

    const { error } = await supabaseAdmin.from("driver_documents").upsert(
      {
        driver_id: driverId,
        doc_type: body.doc_type,
        storage_path: body.storage_path,
        status: "pending",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "driver_id, doc_type" }
    );

    if (error) {
      return reply.status(500).send({ error: "Failed to save document record" });
    }

    return reply.send({ success: true });
  });

  // GET /drivers/documents — Get driver documents
  app.get("/drivers/documents", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;

    const { data, error } = await supabaseAdmin
      .from("driver_documents")
      .select("*")
      .eq("driver_id", driverId);

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch documents" });
    }

    return reply.send(data);
  });

  // GET /drivers/trips — Paginated completed rides history
  app.get("/drivers/trips", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { limit = "10", cursor } = request.query as { limit?: string; cursor?: string };

    let query = supabaseAdmin
      .from("rides")
      .select("id, origin_address, dest_address, fare_final, completed_at, service_type")
      .eq("driver_id", driverId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(parseInt(limit, 10));

    if (cursor) {
      query = query.lt("completed_at", cursor);
    }

    const { data, error } = await query;
    if (error) {
      return reply.status(500).send({ error: "Failed to fetch trips" });
    }

    return reply.send(data);
  });

  // GET /drivers/payouts — Driver payout history and pending balance
  app.get("/drivers/payouts", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;

    // Get payouts
    const { data: payouts, error: payoutsError } = await supabaseAdmin
      .from("driver_payouts")
      .select("*")
      .eq("driver_id", driverId)
      .order("created_at", { ascending: false });

    if (payoutsError) {
      return reply.status(500).send({ error: "Failed to fetch payouts" });
    }

    // Calculate pending balance by summing earnings since the last payout
    const lastPayoutDate = payouts?.[0]?.period_end || new Date(0).toISOString();
    
    const { data: pendingEarnings } = await supabaseAdmin
      .from("earnings")
      .select("net")
      .eq("driver_id", driverId)
      .gt("created_at", lastPayoutDate);

    const pendingBalance = (pendingEarnings || []).reduce((sum, e) => sum + (e.net || 0), 0);

    return reply.send({
      payouts: payouts || [],
      pending_balance: pendingBalance,
    });
  });

  // PUT /drivers/profile — Edit driver profile
  app.put("/drivers/profile", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { name, vehicle_model, vehicle_plate } = request.body as any;

    const { error: driverError } = await supabaseAdmin
      .from("drivers")
      .update({ name })
      .eq("id", driverId);

    if (driverError) {
      return reply.status(500).send({ error: "Failed to update driver details" });
    }

    if (vehicle_model || vehicle_plate) {
      const { error: vehicleError } = await supabaseAdmin
        .from("vehicles")
        .update({ model: vehicle_model, plate: vehicle_plate })
        .eq("driver_id", driverId);

      if (vehicleError) {
        return reply.status(500).send({ error: "Failed to update vehicle details" });
      }
    }

    return reply.send({ success: true });
  });

  // GET /drivers/schedule — Assigned upcoming fleet/scheduled jobs
  app.get("/drivers/schedule", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;

    const { data, error } = await supabaseAdmin
      .from("scheduled_jobs")
      .select("*")
      .eq("assigned_driver_id", driverId)
      .gte("scheduled_time", new Date().toISOString())
      .order("scheduled_time", { ascending: true });

    if (error) {
      console.error("Scheduled jobs error:", error);
      return reply.status(500).send({ error: "Failed to fetch scheduled jobs" });
    }

    return reply.send(data || []);
  });
}


