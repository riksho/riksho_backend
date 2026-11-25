import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { supabaseAnon, supabaseAdmin } from "../../config/supabase.js";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("FATAL: JWT_SECRET environment variable must be set in production");
}

export interface DusmintAuthUser {
  id: string;
  sub: string;
  phone?: string;
  email?: string;
  role?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    dusmintUser?: DusmintAuthUser;
  }
}

/**
 * DusMint Auth Guard
 * Verifies Supabase Auth JWTs or internal DusMint JWTs seamlessly.
 */
export async function dusmintAuthGuard(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({
      message: "Unauthorized. Missing or invalid Authorization header.",
    });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  // 1. Try Supabase Auth verification
  try {
    const { data, error } = await supabaseAnon.auth.getUser(token);
    if (!error && data?.user) {
      const userObj: DusmintAuthUser = {
        id: data.user.id,
        sub: data.user.id,
        phone: data.user.phone,
        email: data.user.email,
        role: data.user.user_metadata?.role || "customer",
      };
      (request as any).user = userObj;
      request.dusmintUser = userObj;
      return;
    }
  } catch {
    // Continue to fallback JWT verification
  }

  // 2. Try internal JWT verification
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded && (decoded.sub || decoded.id)) {
      const userId = decoded.sub || decoded.id;
      const userObj: DusmintAuthUser = {
        id: userId,
        sub: userId,
        phone: decoded.phone,
        role: decoded.role || "customer",
      };
      (request as any).user = userObj;
      request.dusmintUser = userObj;
      return;
    }
  } catch {
    // Continue to dev fallback if applicable
  }

  // 3. Fallback for local development ONLY — blocked in production
  if ((token.startsWith("dev-") || token === "test-token") && process.env.NODE_ENV !== "production") {
    const defaultUserId = "76a64e55-e036-4d6b-9875-a8a7214ba6d3";
    const userObj: DusmintAuthUser = {
      id: defaultUserId,
      sub: defaultUserId,
      role: "customer",
    };
    (request as any).user = userObj;
    request.dusmintUser = userObj;
    return;
  }

  return reply.status(401).send({
    message: "Unauthorized. Please login with OTP.",
  });
}
