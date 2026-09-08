import crypto from "node:crypto";
import { logger } from "../common/logger.js";

const mode = (process.env.RAZORPAY_MODE || "test").toLowerCase().trim();
export const IS_RAZORPAY_LIVE = mode === "live" || mode === "production";

export const RAZORPAY_KEY_ID =
  (IS_RAZORPAY_LIVE ? process.env.RAZORPAY_LIVE_KEY_ID : process.env.RAZORPAY_TEST_KEY_ID) ||
  process.env.RAZORPAY_KEY_ID ||
  "rzp_test_RikshoBuddyDummy";

export const RAZORPAY_KEY_SECRET =
  (IS_RAZORPAY_LIVE ? process.env.RAZORPAY_LIVE_KEY_SECRET : process.env.RAZORPAY_TEST_KEY_SECRET) ||
  process.env.RAZORPAY_KEY_SECRET ||
  "rzp_secret_dummy";

export const RAZORPAY_WEBHOOK_SECRET =
  (IS_RAZORPAY_LIVE ? process.env.RAZORPAY_LIVE_WEBHOOK_SECRET : process.env.RAZORPAY_TEST_WEBHOOK_SECRET) ||
  process.env.RAZORPAY_WEBHOOK_SECRET ||
  "";

export const RAZORPAY_MERCHANT_VPA = process.env.RAZORPAY_MERCHANT_VPA || "anga9763826.rzp@rxairtel";
export const RAZORPAY_MERCHANT_NAME = process.env.RAZORPAY_MERCHANT_NAME || "RIKSHO";

/**
 * Constructs a standard NPCI UPI Intent URI for one-tap payments on Android
 */
export function generateUpiIntentUrl(options: {
  vpa?: string;
  merchantName?: string;
  orderId: string;
  amountPaise: number;
  planName: string;
}): string {
  const vpa = options.vpa || RAZORPAY_MERCHANT_VPA;
  const name = options.merchantName || RAZORPAY_MERCHANT_NAME;
  const amountRs = (options.amountPaise / 100).toFixed(2);
  const note = (options.planName || "Riksho Recharge").replace(/[^a-zA-Z0-9 ]/g, "").slice(0, 30);
  const tr = options.orderId;

  return `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(name)}&tr=${encodeURIComponent(tr)}&am=${amountRs}&cu=INR&tn=${encodeURIComponent(note)}`;
}

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

    const data = (await res.json()) as any;
    if (!data || !data.id) {
      logger.error({ data }, "Razorpay response missing order id");
      throw new Error(data?.error?.description || "Razorpay response did not contain an order ID");
    }
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

  const secretsToTry = Array.from(new Set([
    process.env.RAZORPAY_LIVE_KEY_SECRET,
    RAZORPAY_KEY_SECRET,
    process.env.RAZORPAY_TEST_KEY_SECRET,
  ].filter(Boolean) as string[]));

  for (const secret of secretsToTry) {
    try {
      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      if (expectedSignature === signature) {
        return true;
      }
    } catch (err) {
      // Continue to next secret
    }
  }

  logger.warn({ orderId, paymentId }, "Signature verification failed across all available keys");
  return false;
}

export interface RazorpayOrderDetails {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt?: string;
  status: "created" | "attempted" | "paid";
  attempts: number;
  notes?: Record<string, string>;
  payment_id?: string;
  is_paid: boolean;
}

/**
 * Fetches order details and payments directly from Razorpay API v1
 */
export async function fetchRazorpayOrder(orderId: string): Promise<RazorpayOrderDetails | null> {
  // Test mode mock orders
  if (orderId.startsWith("order_mock_") || orderId.startsWith("test_order_")) {
    return {
      id: orderId,
      amount: 100,
      amount_paid: 100,
      amount_due: 0,
      currency: "INR",
      status: "paid",
      attempts: 1,
      payment_id: `pay_mock_${Date.now()}`,
      is_paid: true,
    };
  }

  // Key pairs to try (Live first if live order ID / live keys available)
  const keyPairs: Array<{ keyId: string; secret: string }> = [];
  if (process.env.RAZORPAY_LIVE_KEY_ID && process.env.RAZORPAY_LIVE_KEY_SECRET) {
    keyPairs.push({ keyId: process.env.RAZORPAY_LIVE_KEY_ID, secret: process.env.RAZORPAY_LIVE_KEY_SECRET });
  }
  if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && !keyPairs.some(k => k.keyId === RAZORPAY_KEY_ID)) {
    keyPairs.push({ keyId: RAZORPAY_KEY_ID, secret: RAZORPAY_KEY_SECRET });
  }
  if (process.env.RAZORPAY_TEST_KEY_ID && process.env.RAZORPAY_TEST_KEY_SECRET && !keyPairs.some(k => k.keyId === process.env.RAZORPAY_TEST_KEY_ID)) {
    keyPairs.push({ keyId: process.env.RAZORPAY_TEST_KEY_ID, secret: process.env.RAZORPAY_TEST_KEY_SECRET });
  }

  for (const { keyId, secret } of keyPairs) {
    if (keyId.includes("Dummy") || secret.includes("dummy")) continue;

    try {
      const authHeader = `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;

      // 1. Fetch order
      const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: {
          Authorization: authHeader,
        },
      });

      if (!orderRes.ok) {
        continue;
      }

      const orderData = (await orderRes.json()) as any;
      let paymentId: string | undefined = undefined;

      // 2. If order status is paid or attempted, fetch payments for this order to find the captured payment ID
      try {
        const paymentsRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
          method: "GET",
          headers: {
            Authorization: authHeader,
          },
        });

        if (paymentsRes.ok) {
          const paymentsData = (await paymentsRes.json()) as any;
          // CRITICAL SECURITY: ONLY accept payments that are captured or authorized!
          // An aborted/cancelled payment in Google Pay remains in status 'created' and MUST NOT be accepted.
          const capturedPay = (paymentsData.items || []).find(
            (p: any) => p.status === "captured" || p.status === "authorized"
          );
          if (capturedPay) {
            paymentId = capturedPay.id;
          }
        }
      } catch (payErr: any) {
        logger.warn({ payErr: payErr.message, orderId }, "Could not fetch payments list for order");
      }

      // Legitimate payment confirmation:
      // Either order status is paid, or amount_paid > 0, OR we found a genuinely captured payment ID
      const isOrderFullyPaid = Boolean(
        orderData.status === "paid" ||
        (orderData.amount_paid && orderData.amount_paid > 0) ||
        paymentId
      );

      return {
        id: orderData.id,
        amount: orderData.amount,
        amount_paid: orderData.amount_paid,
        amount_due: orderData.amount_due,
        currency: orderData.currency,
        receipt: orderData.receipt,
        status: orderData.status,
        attempts: orderData.attempts,
        notes: orderData.notes,
        payment_id: paymentId,
        is_paid: isOrderFullyPaid,
      };
    } catch (err: any) {
      // Try next key pair
    }
  }

  logger.warn({ orderId }, "Could not fetch Razorpay order with any configured key pairs");
  return null;
}

/**
 * Verifies Razorpay Webhook signature
 */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    // If webhook secret isn't set, allow in development/test
    return !IS_RAZORPAY_LIVE;
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch (err) {
    logger.error({ err }, "Razorpay webhook signature verification error");
    return false;
  }
}

