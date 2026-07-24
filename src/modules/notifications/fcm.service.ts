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

/**
 * Send a push notification to specific device tokens.
 */
export async function sendToTokens(tokens: string[], payload: PushPayload): Promise<number> {
  const messaging = getMessaging();
  if (!messaging || tokens.length === 0) return 0;

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
    return response.successCount;
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to send FCM multicast");
    throw err;
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
