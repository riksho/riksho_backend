import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { sendToAllUsers, sendToTopic, sendToTokens, pruneInvalidTokens, savePushHistory } from "./fcm.service.js";
import { logger } from "../../common/logger.js";
import { z } from "zod";

const SendPushSchema = z.object({
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(500),
  imageUrl: z.string().url().optional().nullable().or(z.literal("")),
  target: z.enum(["all_users", "riders", "drivers"]).default("all_users"),
});

const FcmRegisterSchema = z.object({
  token: z.string().min(10),
  platform: z.enum(["android", "ios"]).default("android"),
});

export async function fcmRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: [authGuard, requireRole("admin")] };

  /**
   * POST /admin/push/send — Admin broadcasts a push notification (deduplicated)
   */
  app.post("/admin/push/send", adminGuard, async (request, reply) => {
    const { title, body, imageUrl, target } = SendPushSchema.parse(request.body);
    const cleanImageUrl = imageUrl && imageUrl.trim().length > 0 ? imageUrl.trim() : undefined;

    try {
      let tokens: string[] = [];

      if (target === "all_users") {
        const { data: tokenRows } = await supabaseAdmin
          .from("push_tokens")
          .select("user_id, token, updated_at")
          .order("updated_at", { ascending: false });

        tokens = Array.from(new Set((tokenRows || []).map((r) => r.token).filter(Boolean)));
      } else if (target === "drivers") {
        const { data: driverRows } = await supabaseAdmin.from("drivers").select("id");
        const driverUserIds = new Set((driverRows || []).map((d) => d.id));
        if (driverUserIds.size > 0) {
          const { data: tokenRows } = await supabaseAdmin
            .from("push_tokens")
            .select("user_id, token, updated_at")
            .order("updated_at", { ascending: false });

          tokens = Array.from(new Set(
            (tokenRows || [])
              .filter((r) => r.user_id && driverUserIds.has(r.user_id) && r.token)
              .map((r) => r.token)
          ));
        }
      } else if (target === "riders") {
        const { data: driverRows } = await supabaseAdmin.from("drivers").select("id");
        const driverUserIds = new Set((driverRows || []).map((d) => d.id));
        const { data: tokenRows } = await supabaseAdmin
          .from("push_tokens")
          .select("user_id, token, updated_at")
          .order("updated_at", { ascending: false });

        tokens = Array.from(new Set(
          (tokenRows || [])
            .filter((r) => r.user_id && !driverUserIds.has(r.user_id) && r.token)
            .map((r) => r.token)
        ));
      }

      let messageId: string | null = null;

      // Direct Multicast to active device tokens (strictly 1 notification per unique device token)
      if (tokens.length > 0) {
        for (let i = 0; i < tokens.length; i += 500) {
          const chunk = tokens.slice(i, i + 500);
          const result = await sendToTokens(chunk, { title, body, imageUrl: cleanImageUrl });
          if (result.invalidTokens && result.invalidTokens.length > 0) {
            await pruneInvalidTokens(result.invalidTokens);
          }
        }
        messageId = `multicast-${tokens.length}-devices`;
      } else {
        // Fallback to topic broadcast if no database tokens exist yet
        if (target === "all_users") {
          messageId = await sendToAllUsers({ title, body, imageUrl: cleanImageUrl });
        } else {
          messageId = await sendToTopic(target, { title, body, imageUrl: cleanImageUrl });
        }
      }

      // Save to history
      await savePushHistory(title, body, target, request.user!.id, messageId, cleanImageUrl);

      return reply.send({
        success: true,
        messageId,
        message: `Notification sent to ${target} (${tokens.length > 0 ? tokens.length + ' devices' : 'via topic'})`,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, "Admin push send failed");
      return reply.status(500).send({
        error: "PUSH_SEND_FAILED",
        message: err.message || "Failed to send push notification",
      });
    }
  });

  /**
   * GET /admin/push/history — Get recently sent notifications (Paginated, 8 per page default)
   */
  app.get("/admin/push/history", adminGuard, async (request, reply) => {
    const { page = "0", limit = "8" } = request.query as any;
    const pageNum = Math.max(0, parseInt(page, 10) || 0);
    const limitNum = Math.max(1, parseInt(limit, 10) || 8);

    const from = pageNum * limitNum;
    const to = from + limitNum - 1;

    const { data, count, error } = await supabaseAdmin
      .from("push_history")
      .select("*", { count: "exact" })
      .order("sent_at", { ascending: false })
      .range(from, to);

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch push history" });
    }

    return {
      items: data ?? [],
      total: count ?? 0,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil((count ?? 0) / limitNum),
    };
  });

  /**
   * DELETE /admin/push/history — Clear all notification history
   */
  app.delete("/admin/push/history", adminGuard, async (request, reply) => {
    const { error } = await supabaseAdmin
      .from("push_history")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");

    if (error) {
      logger.error({ error }, "Failed to clear push history");
      return reply.status(500).send({ error: "Failed to clear push history" });
    }

    return reply.send({ success: true, message: "Broadcast history cleared successfully" });
  });

  /**
   * POST /push/fcm-register — Register a device's FCM token
   * Called by the mobile app on startup after getting the FCM token.
   */
  app.post("/push/fcm-register", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const { token, platform } = FcmRegisterSchema.parse(request.body);

    // Upsert latest token for this user and device
    const { error } = await supabaseAdmin
      .from("push_tokens")
      .upsert(
        {
          user_id: userId,
          token,
          platform,
          token_type: "fcm",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,token" }
      );

    if (error) {
      logger.error({ userId, error }, "Failed to register FCM token");
      return reply.status(500).send({ error: "Failed to register token", details: error.message, hint: error.hint });
    }

    // Drop any other user's claim on this exact device token (e.g. device transferred/reassigned)
    const { error: cleanupError } = await supabaseAdmin
      .from("push_tokens")
      .delete()
      .eq("token", token)
      .neq("user_id", userId);

    if (cleanupError) {
      logger.warn({ userId, err: cleanupError.message }, "Failed to clear stale token owners");
    }

    return reply.send({ success: true });
  });

  /**
   * POST /push/fcm-unregister — Remove a device's FCM token on logout
   */
  app.post("/push/fcm-unregister", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const { token } = (request.body || {}) as { token?: string };

    if (token) {
      await supabaseAdmin
        .from("push_tokens")
        .delete()
        .eq("user_id", userId)
        .eq("token", token);
    }

    return reply.send({ success: true });
  });
}
