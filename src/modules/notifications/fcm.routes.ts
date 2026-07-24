import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { sendToAllUsers, sendToTopic, savePushHistory } from "./fcm.service.js";
import { logger } from "../../common/logger.js";
import { z } from "zod";

const SendPushSchema = z.object({
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(500),
  imageUrl: z.string().url().optional(),
  target: z.enum(["all_users", "riders", "drivers"]).default("all_users"),
});

const FcmRegisterSchema = z.object({
  token: z.string().min(10),
  platform: z.enum(["android", "ios"]).default("android"),
});

export async function fcmRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: [authGuard, requireRole("admin")] };

  /**
   * POST /admin/push/send — Admin broadcasts a push notification
   */
  app.post("/admin/push/send", adminGuard, async (request, reply) => {
    const { title, body, imageUrl, target } = SendPushSchema.parse(request.body);

    try {
      let messageId: string | null = null;

      if (target === "all_users") {
        messageId = await sendToAllUsers({ title, body, imageUrl });
      } else {
        messageId = await sendToTopic(target, { title, body, imageUrl });
      }

      // Save to history
      await savePushHistory(title, body, target, request.user!.id, messageId, imageUrl);

      return reply.send({
        success: true,
        messageId,
        message: `Notification sent to ${target}`,
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
        { onConflict: "user_id" }
      );

    if (error) {
      logger.error({ userId, error }, "Failed to register FCM token");
      return reply.status(500).send({ error: "Failed to register token" });
    }

    return reply.send({ success: true });
  });
}
