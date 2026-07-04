import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";

export async function pushRoutes(app: FastifyInstance) {
  // POST /push/register — Register a push token
  app.post("/push/register", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = request.body as { token: string; platform: string };

    if (!body.token || !body.platform) {
      return reply.status(400).send({ error: "token and platform are required" });
    }

    const { error } = await supabaseAdmin
      .from("push_tokens")
      .upsert(
        {
          user_id: userId,
          token: body.token,
          platform: body.platform,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (error) {
      return reply.status(500).send({ error: "Failed to register token", details: error.message });
    }

    return reply.send({ success: true });
  });
}
