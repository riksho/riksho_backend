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

    return reply.send(userData);
  });

  // GET /me/contacts — Get user's saved contacts
  app.get("/me/contacts", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    
    const { data, error } = await supabaseAdmin
      .from("user_contacts")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch contacts" });
    }
    return reply.send(data);
  });

  // POST /me/contacts — Save a new contact
  app.post("/me/contacts", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { name: string; phone: string };

    if (!body.name || !body.phone) {
      return reply.status(400).send({ error: "Name and phone are required" });
    }

    const { data, error } = await supabaseAdmin
      .from("user_contacts")
      .insert({
        user_id: userId,
        name: body.name,
        phone: body.phone,
      })
      .select()
      .single();

    if (error) {
      // If unique constraint violation
      if (error.code === "23505") {
        return reply.status(400).send({ error: "Contact with this phone already exists" });
      }
      return reply.status(500).send({ error: "Failed to save contact" });
    }
    return reply.send(data);
  });
}
