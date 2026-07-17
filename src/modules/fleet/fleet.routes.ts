import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js"; // note: authGuard is here, we will need roles.guard.js
import { requireRole as roleGuard } from "../../common/roles.guard.js";

const ScheduleJobSchema = z.object({
  origin_lat: z.number(),
  origin_lng: z.number(),
  origin_address: z.string(),
  dest_lat: z.number(),
  dest_lng: z.number(),
  dest_address: z.string(),
  vehicle_type: z.enum(["tempo", "mini_truck", "truck"]),
  cargo_weight_kg: z.number(),
  is_recurring: z.boolean(),
  cron_expression: z.string().optional(),
  next_run_at: z.string().optional(), // ISO string for deferred job
});

export async function fleetRoutes(app: FastifyInstance) {
  // POST /fleet/schedule — Schedule a recurring or deferred job (for Web Portal authenticated via JWT)
  // NOTE: role stays "customer" for business accounts (only account_type flips to
  // 'business'); ownership is enforced via the businesses lookup below.
  app.post("/fleet/schedule", { preHandler: [authGuard, roleGuard("customer")] }, async (request, reply) => {
    const businessId = request.user!.id; // For simplicity, assume user.id maps to business owner, but wait!
    // We should fetch the actual business_id for the user
    const { data: business } = await supabaseAdmin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", businessId)
      .single();

    if (!business) {
      return reply.status(403).send({ error: "No business account found for this user" });
    }

    const body = ScheduleJobSchema.parse(request.body);

    const { data: scheduledJob, error } = await supabaseAdmin
      .from("scheduled_jobs")
      .insert({
        business_id: business.id,
        ...body,
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to schedule job" });
    }

    return reply.status(201).send({ message: "Job scheduled successfully", scheduledJob });
  });

  // GET /fleet/schedule - Get all scheduled jobs for the business
  app.get("/fleet/schedule", { preHandler: [authGuard, roleGuard("customer")] }, async (request, reply) => {
    const businessId = request.user!.id; 
    const { data: business } = await supabaseAdmin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", businessId)
      .single();

    if (!business) return reply.status(403).send({ error: "No business account found" });

    const { data: jobs, error } = await supabaseAdmin
      .from("scheduled_jobs")
      .select("*")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false });

    if (error) return reply.status(500).send({ error: "Failed to fetch scheduled jobs" });

    return reply.send({ jobs });
  });

  // POST /fleet/jobs/:id/start — Driver materializes an assigned scheduled job into
  // a live ride and starts navigation. Only the pre-assigned driver may start it.
  // If the scheduler already materialized this job (ride_id set), that ride is returned
  // instead of creating a duplicate.
  app.post("/fleet/jobs/:id/start", { preHandler: [authGuard, roleGuard("driver")] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { id } = request.params as { id: string };

    const { data: job, error: jobErr } = await supabaseAdmin
      .from("scheduled_jobs")
      .select("*")
      .eq("id", id)
      .single();

    if (jobErr || !job) return reply.status(404).send({ error: "Scheduled job not found" });
    if (job.assigned_driver_id !== driverId) {
      return reply.status(403).send({ error: "This job is not assigned to you" });
    }

    // Idempotency: if a ride already exists for this job, return it.
    if (job.ride_id) {
      return reply.send({ ride_id: job.ride_id, reused: true });
    }

    // Route + fare (OSRM, mirrors the scheduler path).
    let distanceM = 0;
    let durationS = 0;
    try {
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${job.origin_lng},${job.origin_lat};${job.dest_lng},${job.dest_lat}?overview=false`;
      const routeRes = await fetch(osrmUrl);
      const routeData = (await routeRes.json()) as any;
      if (routeData.routes?.length) {
        distanceM = Math.round(routeData.routes[0].distance);
        durationS = Math.round(routeData.routes[0].duration);
      }
    } catch {
      // proceed with 0 distance
    }
    const { calculateFare } = await import("../fares/fares.config.js");
    const fareEst = calculateFare(job.vehicle_type as any, distanceM, durationS, 1.0, job.cargo_weight_kg);

    // Create the ride already accepted by this driver (they explicitly started it).
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from("rides")
      .insert({
        driver_id: driverId,
        business_id: job.business_id,
        origin_lat: job.origin_lat,
        origin_lng: job.origin_lng,
        origin_address: job.origin_address,
        dest_lat: job.dest_lat,
        dest_lng: job.dest_lng,
        dest_address: job.dest_address,
        vehicle_type: job.vehicle_type,
        service_type: "fleet",
        cargo_weight_kg: job.cargo_weight_kg,
        distance_m: distanceM,
        duration_s: durationS,
        fare_estimate: fareEst,
        status: "accepted",
        payment_method: "invoice",
        payment_status: "pending",
      })
      .select()
      .single();

    if (rideErr || !ride) {
      return reply.status(500).send({ error: "Failed to start job" });
    }

    // Link the ride back to the job and stop it re-firing.
    await supabaseAdmin
      .from("scheduled_jobs")
      .update({ ride_id: ride.id, is_active: false })
      .eq("id", id);

    return reply.status(201).send({ ride_id: ride.id, status: ride.status, fare_estimate: fareEst });
  });
}
