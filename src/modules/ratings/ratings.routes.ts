import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";

export async function ratingsRoutes(app: FastifyInstance) {
  // POST /ratings — Submit a rating
  app.post("/ratings", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as {
      ride_id: string;
      stars: number;
      comment?: string;
    };

    if (!body.ride_id || !body.stars || body.stars < 1 || body.stars > 5) {
      return reply.status(400).send({ error: "ride_id and stars (1-5) are required" });
    }

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

    const { data, error } = await supabaseAdmin
      .from("ratings")
      .insert({
        ride_id: body.ride_id,
        by: isCustomer ? "customer" : "driver",
        stars: body.stars,
        comment: body.comment || null,
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to submit rating", details: error.message });
    }

    // Update driver's average rating if rated by customer
    if (isCustomer && ride.driver_id) {
      const { data: allRatings } = await supabaseAdmin
        .from("ratings")
        .select("stars")
        .eq("ride_id", body.ride_id);

      // Simple average for now
      if (allRatings?.length) {
        const { data: driverRatings } = await supabaseAdmin
          .from("ratings")
          .select("stars, rides!inner(driver_id)")
          .eq("by", "customer");

        // Update driver rating (simplified)
        const avg = allRatings.reduce((s, r) => s + r.stars, 0) / allRatings.length;
        await supabaseAdmin
          .from("drivers")
          .update({ rating: +avg.toFixed(2) })
          .eq("id", ride.driver_id);
      }
    }

    return reply.status(201).send(data);
  });
}
