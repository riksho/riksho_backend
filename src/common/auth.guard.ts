import type { FastifyRequest, FastifyReply } from "fastify";
import { supabaseAnon } from "../config/supabase.js";

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

    request.user = {
      id: data.user.id,
      phone: data.user.phone,
      email: data.user.email,
      role: data.user.user_metadata?.role || "customer",
    };
  } catch (err) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Token verification failed",
    });
  }
}
