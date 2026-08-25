import crypto from "node:crypto";
import { logger } from "../common/logger.js";

export const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_RikshoBuddyDummy";
export const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "rzp_secret_dummy";

/**
 * Creates an order directly via Razorpay API v1
 */
export async function createRazorpayOrder(options: {
  amount: number; // in paise
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string }> {
  const { amount, currency = "INR", receipt = `rcpt_${Date.now()}`, notes = {} } = options;

  // If running in test mode with dummy keys, generate mock order
  if (RAZORPAY_KEY_ID.includes("Dummy") || RAZORPAY_KEY_SECRET.includes("dummy")) {
    const mockId = `order_mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    logger.info({ mockId, amount }, "Razorpay test mode: generated mock order");
    return {
      id: mockId,
      amount,
      currency,
    };
  }

  try {
    const authHeader = `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`;
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        amount,
        currency,
        receipt,
        notes,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error({ status: res.status, errBody }, "Razorpay order creation failed");
      throw new Error(`Razorpay API Error: ${errBody}`);
    }

    const data = (await res.json()) as { id: string; amount: number; currency: string };
    return {
      id: data.id,
      amount: data.amount,
      currency: data.currency,
    };
  } catch (err: any) {
    logger.error({ err: err.message }, "Error calling Razorpay Orders API");
    throw err;
  }
}

/**
 * Verifies Razorpay HMAC-SHA256 signature
 */
export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  // Test mode bypass for mock orders
  if (orderId.startsWith("order_mock_") || signature === "test_signature_mock") {
    return true;
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    return expectedSignature === signature;
  } catch (err) {
    logger.error({ err }, "Signature verification error");
    return false;
  }
}
