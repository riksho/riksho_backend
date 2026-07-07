import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import crypto from "crypto";

/**
 * Fires a webhook to all active endpoints for a given business when a shipment changes state.
 */
export async function fireWebhook(businessId: string, event: string, payload: any) {
  try {
    const { data: endpoints } = await supabaseAdmin
      .from("webhook_endpoints")
      .select("url, secret")
      .eq("business_id", businessId)
      .eq("is_active", true);

    if (!endpoints || endpoints.length === 0) return;

    const payloadString = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });

    for (const endpoint of endpoints) {
      // Create HMAC signature
      const signature = crypto
        .createHmac("sha256", endpoint.secret)
        .update(payloadString)
        .digest("hex");

      fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Riksho-Signature": signature,
        },
        body: payloadString,
      }).catch(err => {
        logger.warn({ url: endpoint.url, err: err.message }, "Webhook delivery failed");
      });
    }
  } catch (err) {
    logger.error({ businessId, event }, "Error firing webhook");
  }
}
