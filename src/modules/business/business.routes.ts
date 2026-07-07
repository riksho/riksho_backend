import { FastifyInstance } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard, requireRole } from "../../common/auth.guard.js";
import { BusinessRegisterSchema } from "../../common/schemas.js";

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
  app.get("/business/me", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
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
}
