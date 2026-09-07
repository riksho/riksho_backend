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
    };
  }

  if (RAZORPAY_KEY_ID.includes("Dummy") || RAZORPAY_KEY_SECRET.includes("dummy")) {
    return null;
  }

  try {
    const authHeader = `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`;

    // 1. Fetch order
    const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
      method: "GET",
      headers: {
        Authorization: authHeader,
      },
    });

    if (!orderRes.ok) {
      const errText = await orderRes.text();
      logger.warn({ status: orderRes.status, errText, orderId }, "Failed to fetch Razorpay order");
      return null;
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
        const capturedPay = (paymentsData.items || []).find(
          (p: any) => p.status === "captured" || p.status === "authorized"
        );
        if (capturedPay) {
          paymentId = capturedPay.id;
        } else if (paymentsData.items && paymentsData.items.length > 0) {
          paymentId = paymentsData.items[0].id;
        }
      }
    } catch (payErr: any) {
      logger.warn({ payErr: payErr.message, orderId }, "Could not fetch payments list for order");
    }

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
    };
  } catch (err: any) {
    logger.error({ err: err.message, orderId }, "Error fetching Razorpay order");
    return null;
  }
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

