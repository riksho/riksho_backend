import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { RatingSchema } from "../../common/schemas.js";

export async function ratingsRoutes(app: FastifyInstance) {
  // POST /ratings — Submit a rating (Zod-validated, upsert for duplicate guard)
  app.post("/ratings", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = RatingSchema.parse(request.body);

    // Verify the ride exists and belongs to this user
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("id, customer_id, driver_id, status")
      .eq("id", body.ride_id)
      .eq("status", "completed")
      .single();

    if (!ride) {
      return reply.status(404).send({ error: "Completed ride not found" });
    }

    const isCustomer = ride.customer_id === userId;
    const isDriver = ride.driver_id === userId;

    if (!isCustomer && !isDriver) {
      return reply.status(403).send({ error: "You are not part of this ride" });
    }

    const ratingBy = isCustomer ? "customer" : "driver";

    // Upsert: unique constraint (ride_id, by) from migration prevents duplicates
    const { data, error } = await supabaseAdmin
      .from("ratings")
      .upsert(
        {
          ride_id: body.ride_id,
          by: ratingBy,
          stars: body.stars,
          comment: body.comment || null,
        },
        { onConflict: "ride_id,by" }
      )
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to submit rating" });
    }

    // Update driver's average rating if rated by customer
    // Uses the recompute_driver_rating RPC from migration 002
    if (isCustomer && ride.driver_id) {
      await supabaseAdmin
        .rpc("recompute_driver_rating", { p_driver_id: ride.driver_id })
        .then(({ error: rpcErr }) => {
          if (rpcErr) {
            // Fallback: manual average if RPC doesn't exist yet
            return manualRecomputeRating(ride.driver_id!);
          }
        });
    }

    return reply.status(201).send(data);
  });
}

/**
 * Fallback rating recompute if the RPC isn't available yet.
 * Correctly averages ALL customer ratings across ALL the driver's rides.
 */
async function manualRecomputeRating(driverId: string) {
  const { data: allRatings } = await supabaseAdmin
    .from("ratings")
    .select("stars, rides!inner(driver_id)")
    .eq("by", "customer")
    .eq("rides.driver_id", driverId);

  if (allRatings?.length) {
    const avg = allRatings.reduce((s, r) => s + r.stars, 0) / allRatings.length;
    await supabaseAdmin
      .from("drivers")
      .update({ rating: +avg.toFixed(2) })
      .eq("id", driverId);
  }
}
