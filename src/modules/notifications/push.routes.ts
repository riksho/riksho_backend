import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { PushRegisterSchema } from "../../common/schemas.js";

export async function pushRoutes(app: FastifyInstance) {
  // POST /push/register — Register a push token (Zod-validated)
  app.post("/push/register", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = PushRegisterSchema.parse(request.body);

    const { error } = await supabaseAdmin
      .from("push_tokens")
      .upsert(
        {
          user_id: userId,
          token: body.token,
          platform: body.platform || "android",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (error) {
      return reply.status(500).send({ error: "Failed to register token" });
    }

    return reply.send({ success: true });
  });
}
