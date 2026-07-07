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
  app.post("/fleet/schedule", { preHandler: [authGuard, roleGuard("business")] }, async (request, reply) => {
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
  app.get("/fleet/schedule", { preHandler: [authGuard, roleGuard("business")] }, async (request, reply) => {
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
}
