import fetch from "node-fetch";
import { supabaseAdmin } from "../../common/supabase";
import { logger } from "../../common/logger";

interface PushData {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Sends a push notification to a list of users via Expo Push API.
 * Uses best-effort delivery.
 */
export async function sendPush(userIds: string[], message: PushData) {
  if (!userIds.length) return;

  try {
    // 1. Fetch tokens for the given users
    const { data: tokens, error } = await supabaseAdmin
      .from("push_tokens")
      .select("token")
      .in("user_id", userIds);

    if (error || !tokens || tokens.length === 0) {
      logger.info({ userIds }, "No push tokens found for users");
      return;
    }

    // 2. Prepare the messages for Expo
    const messages = tokens.map((t) => ({
      to: t.token,
      sound: "default",
      title: message.title,
      body: message.body,
      data: message.data || {},
    }));

    // 3. Send to Expo via HTTP
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      logger.error({ status: response.status }, "Failed to send push notifications to Expo");
      return;
    }

    const tickets = await response.json();
    logger.info({ tickets }, "Sent push notifications");

    // We can handle receipts to remove invalid tokens later, 
    // for now this best-effort approach satisfies Phase 4 constraints.
  } catch (err: any) {
    logger.error({ err: err.message }, "Error sending push notification");
  }
}
