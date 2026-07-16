import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { ProfileUpdateSchema } from "../../common/schemas.js";

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

    return reply.send({ ...user, profile_complete: !!user.name });
  });

  // PUT /me — Update authenticated user's profile (Zod-validated)
  app.put("/me", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = ProfileUpdateSchema.parse(request.body ?? {});

    // 1. Upsert into users (passenger profile)
    const { data: userData, error: userError } = await supabaseAdmin
      .from("users")
      .upsert({
        id: userId,
        ...(body.name && { name: body.name }),
        ...(body.isDriver && { role: "driver" }),
        phone: request.user!.phone,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (userError) {
      return reply.status(500).send({ error: "Failed to update user profile" });
    }

    // 2. If registering from Partner App, also upsert into drivers
    if (body.isDriver) {
      const { error: driverError } = await supabaseAdmin
        .from("drivers")
        .upsert({
          id: userId,
          name: body.name || "Driver", // Drivers table requires a name
          phone: request.user!.phone,
          status: "offline",
          updated_at: new Date().toISOString(),
        });

      if (driverError) {
        request.log.error("Failed to dual-register driver:", driverError);
        // We don't fail the request here, but log it so the user still gets logged in
      }
    }

    return reply.send(userData);
  });
}
