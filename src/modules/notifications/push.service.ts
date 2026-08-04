import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { sendDataMessage, sendToTokens, pruneInvalidTokens } from "./fcm.service.js";

interface PushData {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Fetch every registered FCM token for the given users.
 *
 * A user may legitimately have several rows (phone + tablet) since migration 019
 * repointed the primary key to (user_id, token). We filter on token_type so an
 * untyped or non-FCM row can never reach the FCM transport.
 */
async function getFcmTokens(userIds: string[]): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("push_tokens")
    .select("token")
    .in("user_id", userIds)
    .eq("token_type", "fcm");

  if (error) {
    logger.error({ err: error.message }, "Failed to fetch push tokens");
    return [];
  }

  // Defensive de-dupe: the same device token can in principle be registered
  // against two accounts (driver logs out, another logs in on the same phone).
  return [...new Set((data ?? []).map((r) => r.token).filter(Boolean))];
}

/**
 * Send a *visible* push notification to a list of users via FCM.
 *
 * Use this for status updates the user should see in the system tray
 * ("Driver Accepted", "Trip Completed"). For time-critical driver ride offers
 * that must render as the in-app OfferCard, use `sendRideOfferPush` instead.
 *
 * Best-effort: never throws. Invalid tokens are pruned automatically.
 */
export async function sendPush(userIds: string[], message: PushData): Promise<void> {
  if (!userIds.length) return;

  try {
    const tokens = await getFcmTokens(userIds);

    if (!tokens.length) {
      logger.info({ userIds }, "No FCM tokens found for users — skipping push");
      return;
    }

    // FCM data payload values must be strings. Coerce defensively so a numeric
    // or boolean field (e.g. fare_estimate) doesn't cause FCM to reject the send.
    const stringData = stringifyData(message.data);

    const { successCount, invalidTokens } = await sendToTokens(tokens, {
      title: message.title,
      body: message.body,
      data: stringData,
    });

    logger.info(
      { userCount: userIds.length, tokenCount: tokens.length, successCount },
      "Sent push notifications via FCM"
    );

    if (invalidTokens.length) {
      await pruneInvalidTokens(invalidTokens);
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Error sending push notification");
  }
}

/**
 * Send a *data-only, high-priority* push for a ride offer.
 *
 * Deliberately carries NO `notification` block. That is what lets the driver app
 * receive it in `messaging().onMessage` (foreground) and
 * `setBackgroundMessageHandler` (backgrounded) and render the custom OfferCard
 * with its 15s countdown. If we included a `notification` block, Android would
 * render it in the system tray while backgrounded and our handler would never
 * run — the driver would see a dead notification with no accept button.
 *
 * Best-effort: never throws.
 */
export async function sendRideOfferPush(
  driverIds: string[],
  payload: Record<string, unknown>
): Promise<void> {
  if (!driverIds.length) return;

  try {
    const tokens = await getFcmTokens(driverIds);

    if (!tokens.length) {
      logger.warn({ driverIds }, "No FCM tokens for nearby drivers — offer push not delivered");
      return;
    }

    const { successCount, invalidTokens } = await sendDataMessage(tokens, {
      type: "ride_offer",
      ...stringifyData(payload),
    });

    logger.info(
      { driverCount: driverIds.length, tokenCount: tokens.length, successCount },
      "Sent data-only ride offer push"
    );

    if (invalidTokens.length) {
      await pruneInvalidTokens(invalidTokens);
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Error sending ride offer push");
  }
}

/**
 * FCM requires every data value to be a string. Drop null/undefined entirely
 * rather than sending the literal strings "null"/"undefined" to the client.
 */
function stringifyData(data?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}
