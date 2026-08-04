import { getMessaging } from "../../config/firebase.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";

interface PushPayload {
  title: string;
  body: string;
  imageUrl?: string;
  data?: Record<string, string>;
}

/**
 * Send a push notification to ALL users subscribed to the "all_users" topic.
 * This is the most efficient way to broadcast — Firebase handles fan-out
 * internally, no need to loop through tokens.
 */
export async function sendToAllUsers(payload: PushPayload): Promise<string | null> {
  const messaging = getMessaging();
  if (!messaging) {
    logger.warn("Firebase not initialised — skipping push");
    return null;
  }

  try {
    const message: any = {
      topic: "all_users",
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: "high" as const,
        notification: {
          channelId: "riksho_general",
          sound: "default",
          ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
        },
      },
    };

    if (payload.imageUrl) {
      message.notification.imageUrl = payload.imageUrl;
    }

    const messageId = await messaging.send(message);
    logger.info({ messageId }, "FCM topic message sent to all_users");
    return messageId;
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to send FCM topic message");
    throw err;
  }
}

/**
 * Send a push notification to a specific topic.
 */
export async function sendToTopic(topic: string, payload: PushPayload): Promise<string | null> {
  const messaging = getMessaging();
  if (!messaging) {
    logger.warn("Firebase not initialised — skipping push");
    return null;
  }

  try {
    const message: any = {
      topic,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: "high" as const,
        notification: {
          channelId: "riksho_general",
          sound: "default",
          ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
        },
      },
    };

    if (payload.imageUrl) {
      message.notification.imageUrl = payload.imageUrl;
    }

    const messageId = await messaging.send(message);
    logger.info({ messageId, topic }, "FCM topic message sent");
    return messageId;
  } catch (err: any) {
    logger.error({ err: err.message, topic }, "Failed to send FCM topic message");
    throw err;
  }
}

/** Result of a multicast send, including tokens FCM rejected as permanently dead. */
export interface MulticastResult {
  successCount: number;
  failureCount: number;
  /** Tokens FCM reported as unregistered/invalid — safe to delete from the DB. */
  invalidTokens: string[];
}

/**
 * FCM error codes that mean "this token will never work again".
 * Anything else (quota, internal, unavailable) is transient — do NOT prune on those,
 * or a temporary Firebase outage would wipe every token in the database.
 */
const PERMANENT_TOKEN_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

function collectInvalidTokens(
  response: { responses: Array<{ success: boolean; error?: { code?: string } }> },
  tokens: string[]
): string[] {
  const invalid: string[] = [];
  response.responses.forEach((r, i) => {
    if (!r.success && r.error?.code && PERMANENT_TOKEN_ERRORS.has(r.error.code)) {
      invalid.push(tokens[i]);
    }
  });
  return invalid;
}

/**
 * Send a *visible* notification to specific device tokens.
 * Renders in the system tray when the app is backgrounded.
 */
export async function sendToTokens(
  tokens: string[],
  payload: PushPayload
): Promise<MulticastResult> {
  const empty: MulticastResult = { successCount: 0, failureCount: 0, invalidTokens: [] };
  const messaging = getMessaging();
  if (!messaging || tokens.length === 0) return empty;

  try {
    const message: any = {
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: "high" as const,
        notification: {
          channelId: "riksho_general",
          sound: "default",
          ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
        },
      },
      tokens,
    };

    if (payload.imageUrl) {
      message.notification.imageUrl = payload.imageUrl;
    }

    const response = await messaging.sendEachForMulticast(message);
    logger.info(
      { success: response.successCount, failure: response.failureCount },
      "FCM multicast sent"
    );

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens: collectInvalidTokens(response, tokens),
    };
  } catch (err: any) {
    // Best-effort transport: callers treat push as non-fatal, so swallow rather
    // than throw and risk taking down a ride-state transition.
    logger.error({ err: err.message }, "Failed to send FCM multicast");
    return empty;
  }
}

/**
 * Send a *data-only* high-priority message to specific device tokens.
 *
 * No `notification` block, so Android does NOT auto-render it in the tray —
 * the app's own handler receives it and decides what to draw. This is what makes
 * the driver's custom ride-offer popup (with its countdown and accept/decline
 * buttons) possible while the app is backgrounded.
 *
 * `android.priority: "high"` asks FCM to wake the device immediately rather than
 * batching the message until the next maintenance window. Required for offers,
 * which are worthless if they arrive two minutes late.
 */
export async function sendDataMessage(
  tokens: string[],
  data: Record<string, string>
): Promise<MulticastResult> {
  const empty: MulticastResult = { successCount: 0, failureCount: 0, invalidTokens: [] };
  const messaging = getMessaging();
  if (!messaging || tokens.length === 0) return empty;

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      data,
      android: {
        priority: "high" as const,
        // 60s TTL: a ride offer that could not be delivered within a minute is
        // stale — the ride has almost certainly been taken or cancelled by then.
        ttl: 60 * 1000,
      },
      apns: {
        headers: { "apns-priority": "10", "apns-push-type": "background" },
        payload: { aps: { contentAvailable: true } },
      },
    });

    logger.info(
      { success: response.successCount, failure: response.failureCount },
      "FCM data-only message sent"
    );

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens: collectInvalidTokens(response, tokens),
    };
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to send FCM data message");
    return empty;
  }
}

/**
 * Delete tokens FCM has told us are permanently dead (app uninstalled, token
 * rotated). Keeps the table from filling with garbage that slows every send.
 */
export async function pruneInvalidTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;

  const { error } = await supabaseAdmin.from("push_tokens").delete().in("token", tokens);

  if (error) {
    logger.warn({ err: error.message, count: tokens.length }, "Failed to prune invalid tokens");
  } else {
    logger.info({ count: tokens.length }, "Pruned invalid FCM tokens");
  }
}

/**
 * Save a push notification to the history table.
 */
export async function savePushHistory(
  title: string,
  body: string,
  target: string,
  sentBy: string,
  messageId: string | null,
  imageUrl?: string
) {
  const { error } = await supabaseAdmin.from("push_history").insert({
    title,
    body,
    target,
    sent_by: sentBy,
    fcm_message_id: messageId,
    image_url: imageUrl || null,
    sent_at: new Date().toISOString(),
  });

  if (error) {
    logger.error({ error }, "Failed to save push history");
  }
}
