import type { FastifyInstance } from "fastify";
import { logger } from "../../common/logger.js";

export async function pushRoutes(app: FastifyInstance) {
  /**
   * POST /push/register — RETIRED (see fix A1).
   *
   * This route used to store Expo push tokens. Because `push_tokens` keyed on
   * user_id alone, and the driver app called BOTH this route and
   * /push/fcm-register at startup, the two registrations overwrote each other
   * non-deterministically on every launch. When the Expo token won, ride-offer
   * pushes (sent via FCM) went to a token FCM could not address, and drivers
   * silently stopped receiving offers while backgrounded.
   *
   * The platform now uses FCM exclusively — POST /push/fcm-register is the only
   * registration route. Both apps have had their Expo-token paths removed.
   *
   * Kept as an explicit 410 rather than deleted so that an older installed build
   * calling this endpoint gets a clear, loggable signal instead of a confusing
   * 404 that looks like a routing bug.
   */
  app.post("/push/register", async (request, reply) => {
    logger.warn(
      { ua: request.headers["user-agent"] },
      "Deprecated POST /push/register called — client is on an outdated build"
    );

    return reply.status(410).send({
      error: "ENDPOINT_RETIRED",
      message:
        "Expo push tokens are no longer supported. Use POST /push/fcm-register with an FCM token.",
    });
  });
}
