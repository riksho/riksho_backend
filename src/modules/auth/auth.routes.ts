import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";

export async function authRoutes(app: FastifyInstance) {
  // GET /me — Return authenticated user's profile
  app.get("/me", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;

    // Try to get user profile from users table
    const { data: user, error } = await supabaseAdmin
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();

    if (error && error.code !== "PGRST116") {
      return reply.status(500).send({ error: "Failed to fetch profile" });
    }

    // If no profile exists yet, return basic auth info
    if (!user) {
      return reply.send({
        id: userId,
        phone: request.user!.phone,
        email: request.user!.email,
        role: request.user!.role,
        profile_complete: false,
      });
    }

    return reply.send({ ...user, profile_complete: true });
  });

  // PUT /me — Update authenticated user's profile
  app.put("/me", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { name?: string; email?: string };

    const { data, error } = await supabaseAdmin
      .from("users")
      .upsert({
        id: userId,
        name: body.name,
        phone: request.user!.phone,
        ...(body.email && { email: body.email }),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to update profile", details: error.message });
    }

    return reply.send(data);
  });
}
