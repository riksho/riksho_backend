import type { FastifyRequest, FastifyReply } from "fastify";
import { supabaseAdmin } from "../config/supabase.js";
import crypto from "crypto";

export interface ApiUser {
  business_id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    apiUser?: ApiUser;
  }
}

/**
 * Auth guard — validates X-API-Key header against the api_keys table.
 * Attaches the business_id to `request.apiUser`.
 */
export async function apiKeyGuard(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers["x-api-key"] as string;

  if (!apiKey) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing X-API-Key header",
    });
  }

  // Hash the incoming key to compare with the DB
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

  try {
    const { data: keyRecord, error } = await supabaseAdmin
      .from("api_keys")
      .select("business_id, is_active")
      .eq("key_hash", keyHash)
      .single();

    if (error || !keyRecord || !keyRecord.is_active) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid or inactive API key",
      });
    }

    // Update last_used_at
    await supabaseAdmin
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("key_hash", keyHash);

    request.apiUser = {
      business_id: keyRecord.business_id,
    };
  } catch (err) {
    return reply.status(500).send({
      error: "INTERNAL_SERVER_ERROR",
      message: "Failed to validate API key",
    });
  }
}
