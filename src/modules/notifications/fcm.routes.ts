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

        const userTokenMap = new Map<string, string>();
        (tokenRows || []).forEach((row) => {
          if (row.user_id && row.token && !userTokenMap.has(row.user_id)) {
            userTokenMap.set(row.user_id, row.token);
          }
        });
        tokens = Array.from(userTokenMap.values());
      } else if (target === "drivers") {
        const { data: driverRows } = await supabaseAdmin.from("drivers").select("id");
        const driverUserIds = new Set((driverRows || []).map((d) => d.id));
        if (driverUserIds.size > 0) {
          const { data: tokenRows } = await supabaseAdmin
            .from("push_tokens")
            .select("user_id, token, updated_at")
            .order("updated_at", { ascending: false });

          const userTokenMap = new Map<string, string>();
          (tokenRows || []).forEach((row) => {
            if (row.user_id && driverUserIds.has(row.user_id) && row.token && !userTokenMap.has(row.user_id)) {
              userTokenMap.set(row.user_id, row.token);
            }
          });
          tokens = Array.from(userTokenMap.values());
        }
      } else if (target === "riders") {
        const { data: driverRows } = await supabaseAdmin.from("drivers").select("id");
        const driverUserIds = new Set((driverRows || []).map((d) => d.id));
        const { data: tokenRows } = await supabaseAdmin
          .from("push_tokens")
          .select("user_id, token, updated_at")
          .order("updated_at", { ascending: false });

        const userTokenMap = new Map<string, string>();
        (tokenRows || []).forEach((row) => {
          if (row.user_id && !driverUserIds.has(row.user_id) && row.token && !userTokenMap.has(row.user_id)) {
            userTokenMap.set(row.user_id, row.token);
          }
        });
        tokens = Array.from(userTokenMap.values());
      }

      let messageId: string | null = null;

      // Direct Multicast to active device tokens (strictly 1 notification per unique user)
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
        message: `Notification sent to ${target} (${tokens.length > 0 ? tokens.length + ' unique users' : 'via topic'})`,
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
   * GET /admin/push/history — Get recently sent notifications
   */
  app.get("/admin/push/history", adminGuard, async (request, reply) => {
    const { page = "0" } = request.query as any;
    const pageNum = Number(page);

    const { data, error } = await supabaseAdmin
      .from("push_history")
      .select("*")
      .order("sent_at", { ascending: false })
      .range(pageNum * 20, pageNum * 20 + 19);

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch push history" });
    }

    return data ?? [];
  });

  /**
   * POST /push/fcm-register — Register a device's FCM token
   * Called by the mobile app on startup after getting the FCM token.
   */
  app.post("/push/fcm-register", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const { token, platform } = FcmRegisterSchema.parse(request.body);

    // Upsert latest token for this user
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

    // Clean up older stale tokens for this user to guarantee strictly 1 token per user
    await supabaseAdmin
      .from("push_tokens")
      .delete()
      .eq("user_id", userId)
      .neq("token", token);

    // Drop any other user's claim on this exact device token
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
}
