import type { FastifyRequest, FastifyReply } from "fastify";
import { supabaseAnon, supabaseAdmin } from "../config/supabase.js";

export interface AuthUser {
  id: string;
  phone?: string;
  email?: string;
  role?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Auth guard — extracts and verifies Supabase JWT from the Authorization header.
 * Attaches the decoded user to `request.user`.
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header. Expected: Bearer <token>",
    });
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const { data, error } = await supabaseAnon.auth.getUser(token);

    if (error || !data.user) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid or expired token",
      });
    }

    // Server-authoritative role: read from the users table, NOT the JWT
    // metadata (which is client-influenceable). Falls back to metadata only
    // if the profile row hasn't been created yet.
    const { data: profile } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", data.user.id)
      .single();

    let resolvedRole = profile?.role || data.user.user_metadata?.role || "customer";

    // Auto-repair role if user registered as driver before role fixes
    if (resolvedRole === "customer") {
      const { data: driverProfile } = await supabaseAdmin
        .from("drivers")
        .select("id")
        .eq("id", data.user.id)
        .single();
      
      if (driverProfile) {
        resolvedRole = "driver";
        // Fire and forget auto-repair in DB
        supabaseAdmin.from("users").update({ role: "driver" }).eq("id", data.user.id).then();
      }
    }

    request.user = {
      id: data.user.id,
      phone: data.user.phone,
      email: data.user.email,
      role: resolvedRole,
    };
  } catch (err) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Token verification failed",
    });
  }
}
