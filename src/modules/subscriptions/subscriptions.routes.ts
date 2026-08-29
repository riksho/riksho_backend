import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js";
import { logger } from "../../common/logger.js";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  RAZORPAY_KEY_ID,
} from "../../config/razorpay.js";

const CreateOrderSchema = z.object({
  plan_id: z.string(),
  use_promo_balance: z.boolean().optional().default(false),
});

const VerifyPaymentSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

const TestActivateSchema = z.object({
  plan_id: z.string().optional(),
  duration_hours: z.number().int().positive().optional(),
});

const DEFAULT_FALLBACK_PLANS = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "5 Hours Pass",
    duration_hours: 5,
    original_price: 5000,
    price: 3900,
    badge: "trial",
    is_active: true,
    sort_order: 1,
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    name: "8 Hours Pass",
    duration_hours: 8,
    original_price: 8000,
    price: 5900,
    badge: null,
    is_active: true,
    sort_order: 2,
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    name: "12 Hours Pass",
    duration_hours: 12,
    original_price: 10000,
    price: 7900,
    badge: "best_value",
    is_active: true,
    sort_order: 3,
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    name: "24 Hours Pass",
    duration_hours: 24,
    original_price: 16000,
    price: 12900,
    badge: "day_pass",
    is_active: true,
    sort_order: 4,
  },
];

export async function subscriptionsRoutes(app: FastifyInstance) {
  /**
   * GET /subscriptions/plans — List all active subscription recharge plans
   */
  app.get("/subscriptions/plans", async (_request, reply) => {
    const { data: plans, error } = await supabaseAdmin
      .from("subscription_plans")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    if (error) {
      logger.error({ error }, "Failed to fetch subscription plans");
      return reply.status(500).send({ error: "Failed to fetch plans" });
    }

    // Default fallback plans if table is not yet seeded
    if (!plans || plans.length === 0) {
      return reply.send({ plans: DEFAULT_FALLBACK_PLANS, razorpay_key_id: RAZORPAY_KEY_ID });
    }

    return reply.send({ plans, razorpay_key_id: RAZORPAY_KEY_ID });
  });

  /**
   * GET /subscriptions/active — Fetch current active subscription for driver
   */
  app.get("/subscriptions/active", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const now = Date.now();
    const nowIso = new Date().toISOString();

    // Batch expire all past active subscriptions for this driver
    await supabaseAdmin
      .from("driver_subscriptions")
      .update({ status: "expired", updated_at: nowIso })
      .eq("driver_id", driverId)
      .eq("status", "active")
      .lte("expires_at", nowIso);

    const { data: sub, error } = await supabaseAdmin
      .from("driver_subscriptions")
      .select("*")
      .eq("driver_id", driverId)
      .eq("status", "active")
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      logger.error({ error, driverId }, "Failed to fetch active subscription");
      return reply.status(500).send({ error: "Failed to fetch subscription" });
    }

    if (!sub) {
      return reply.send({ active: false, subscription: null });
    }

    const expiresTime = new Date(sub.expires_at).getTime();
    const remainingMs = Math.max(0, expiresTime - now);
    const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
    const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

    return reply.send({
      active: true,
      subscription: sub,
      remaining_ms: remainingMs,
      remaining_hours: remainingHours,
      remaining_minutes: remainingMinutes,
      formatted_remaining: remainingHours > 0 ? `${remainingHours}h ${remainingMinutes}m` : `${remainingMinutes}m`,
    });
  });

  /**
   * POST /subscriptions/create-order — Create Razorpay order for a plan with promo balance support
   */
  app.post("/subscriptions/create-order", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { plan_id, use_promo_balance } = CreateOrderSchema.parse(request.body);

    // Fetch plan details
    const { data: plan, error: planErr } = await supabaseAdmin
      .from("subscription_plans")
      .select("*")
      .eq("id", plan_id)
      .maybeSingle();

    const fallbackMatch = DEFAULT_FALLBACK_PLANS.find((p) => p.id === plan_id);
    let planName = fallbackMatch?.name || "Driver Pass";
    let durationHours = fallbackMatch?.duration_hours || 24;
    let pricePaise = fallbackMatch?.price || 3900;

    if (!planErr && plan) {
      planName = plan.name;
      durationHours = plan.duration_hours;
      pricePaise = plan.price;
    }

    // Check promo balance
    let discountPaise = 0;
    if (use_promo_balance) {
      const { data: driver } = await supabaseAdmin
        .from("drivers")
        .select("coupon_balance")
        .eq("id", driverId)
        .maybeSingle();

      const balRs = Number(driver?.coupon_balance || 0);
      if (balRs > 0) {
        discountPaise = Math.min(pricePaise, Math.round(balRs * 100));
      }
    }

    const payablePaise = Math.max(0, pricePaise - discountPaise);

    // If 100% covered by promo balance / 0 payable -> activate immediately without Razorpay!
    if (payablePaise <= 0) {
      const { data: existingActive } = await supabaseAdmin
        .from("driver_subscriptions")
        .select("expires_at")
        .eq("driver_id", driverId)
        .eq("status", "active")
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const startTime = new Date();
      let baseTime = startTime.getTime();
      if (existingActive?.expires_at) {
        const existingExpires = new Date(existingActive.expires_at).getTime();
        if (existingExpires > baseTime) {
          baseTime = existingExpires;
        }
      }

      const expiresTime = new Date(baseTime + durationHours * 60 * 60 * 1000);

      // Deduct used promo balance
      const { data: currentDriver } = await supabaseAdmin
        .from("drivers")
        .select("coupon_balance")
        .eq("id", driverId)
        .maybeSingle();
      const currentBal = Number(currentDriver?.coupon_balance || 0);
      const usedRs = discountPaise / 100;
      if (usedRs > 0) {
        await supabaseAdmin
          .from("drivers")
          .update({ coupon_balance: Math.max(0, currentBal - usedRs) })
          .eq("id", driverId);
      }

      const { data: sub } = await supabaseAdmin
        .from("driver_subscriptions")
        .insert({
          driver_id: driverId,
          plan_id: plan ? plan.id : (fallbackMatch ? fallbackMatch.id : null),
          plan_name: planName,
          duration_hours: durationHours,
          amount_paid: 0,
          razorpay_order_id: `promo_covered_${Date.now()}`,
          razorpay_payment_id: `promo_pay_${Date.now()}`,
          status: "active",
          started_at: startTime.toISOString(),
          expires_at: expiresTime.toISOString(),
        })
        .select()
        .single();

      return reply.status(201).send({
        success: true,
        free_activated: true,
        message: `Pass activated using ₹${usedRs.toFixed(0)} promo balance!`,
        subscription: sub,
      });
    }

    try {
      const order = await createRazorpayOrder({
        amount: payablePaise,
        currency: "INR",
        receipt: `sub_${driverId.slice(0, 8)}_${Date.now()}`,
        notes: {
          driver_id: driverId,
          plan_id,
          duration_hours: String(durationHours),
          discount_paise: String(discountPaise),
        },
      });

      // Insert pending subscription row
      const { data: sub, error: insertErr } = await supabaseAdmin
        .from("driver_subscriptions")
        .insert({
          driver_id: driverId,
          plan_id: plan ? plan.id : (fallbackMatch ? fallbackMatch.id : null),
          plan_name: planName,
          duration_hours: durationHours,
          amount_paid: payablePaise,
          razorpay_order_id: order.id,
          status: "pending",
        })
        .select()
        .single();

      if (insertErr) {
        logger.error({ insertErr }, "Failed to record pending subscription");
      }

      return reply.status(201).send({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        razorpay_key_id: RAZORPAY_KEY_ID,
        subscription_id: sub?.id,
        plan_name: planName,
        discount_applied: discountPaise > 0,
        discount_amount: discountPaise,
      });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to initiate Razorpay order");
      return reply.status(500).send({ error: "Failed to initiate recharge order" });
    }
  });

  /**
   * POST /subscriptions/verify-payment — Verify signature and activate plan
   */
  app.post("/subscriptions/verify-payment", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = VerifyPaymentSchema.parse(request.body);

    const isValid = verifyRazorpaySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!isValid) {
      return reply.status(400).send({
        error: "INVALID_SIGNATURE",
        message: "Payment verification failed. Invalid signature.",
      });
    }

    // Find pending subscription
    const { data: sub } = await supabaseAdmin
      .from("driver_subscriptions")
      .select("*")
      .eq("razorpay_order_id", razorpay_order_id)
      .eq("driver_id", driverId)
      .maybeSingle();

    const durationHours = sub?.duration_hours || 24;

    // Check if discount was applied and deduct from promo balance
    if (sub?.plan_id) {
      let planPrice = 0;
      const { data: planRow } = await supabaseAdmin
        .from("subscription_plans")
        .select("price")
        .eq("id", sub.plan_id)
        .maybeSingle();

      if (planRow) {
        planPrice = planRow.price;
      } else {
        const fb = DEFAULT_FALLBACK_PLANS.find((p) => p.id === sub.plan_id);
        if (fb) planPrice = fb.price;
      }

      if (planPrice > (sub.amount_paid || 0)) {
        const discountUsedRs = (planPrice - sub.amount_paid) / 100;
        if (discountUsedRs > 0) {
          const { data: dRow } = await supabaseAdmin
            .from("drivers")
            .select("coupon_balance")
            .eq("id", driverId)
            .maybeSingle();
          const currentBal = Number(dRow?.coupon_balance || 0);
          await supabaseAdmin
            .from("drivers")
            .update({ coupon_balance: Math.max(0, currentBal - discountUsedRs) })
            .eq("id", driverId);
        }
      }
    }

    // Check if driver already has an unexpired subscription -> stack duration
    const { data: existingActive } = await supabaseAdmin
      .from("driver_subscriptions")
      .select("expires_at")
      .eq("driver_id", driverId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const startTime = new Date();
    let baseTime = startTime.getTime();
    if (existingActive?.expires_at) {
      const existingExpires = new Date(existingActive.expires_at).getTime();
      if (existingExpires > baseTime) {
        baseTime = existingExpires; // Stack on top of remaining time!
      }
    }

    const expiresTime = new Date(baseTime + durationHours * 60 * 60 * 1000);

    let updatedSub = null;
    if (sub) {
      const { data } = await supabaseAdmin
        .from("driver_subscriptions")
        .update({
          razorpay_payment_id,
          status: "active",
          started_at: startTime.toISOString(),
          expires_at: expiresTime.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sub.id)
        .select()
        .single();
      updatedSub = data;
    } else {
      const { data } = await supabaseAdmin
        .from("driver_subscriptions")
        .insert({
          driver_id: driverId,
          plan_name: `${durationHours} Hours Pass`,
          duration_hours: durationHours,
          amount_paid: 4900,
          razorpay_order_id,
          razorpay_payment_id,
          status: "active",
          started_at: startTime.toISOString(),
          expires_at: expiresTime.toISOString(),
        })
        .select()
        .single();
      updatedSub = data;
    }

    return reply.send({
      success: true,
      message: `Recharge successful! Active for ${durationHours} hours.`,
      subscription: updatedSub,
    });
  });

  /**
   * POST /subscriptions/test-activate — Quick test activation for sandbox testing
   */
  app.post("/subscriptions/test-activate", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const body = TestActivateSchema.parse(request.body || {});

    let durationHours = body.duration_hours || 24;
    let planName = `${durationHours} Hours Test Pass`;

    if (body.plan_id) {
      const { data: plan } = await supabaseAdmin
        .from("subscription_plans")
        .select("*")
        .eq("id", body.plan_id)
        .maybeSingle();

      if (plan) {
        durationHours = plan.duration_hours;
        planName = plan.name;
      }
    }

    const startTime = new Date();
    const expiresTime = new Date(startTime.getTime() + durationHours * 60 * 60 * 1000);

    const { data: sub, error } = await supabaseAdmin
      .from("driver_subscriptions")
      .insert({
        driver_id: driverId,
        plan_id: body.plan_id || null,
        plan_name: planName,
        duration_hours: durationHours,
        amount_paid: 0,
        razorpay_order_id: `test_order_${Date.now()}`,
        razorpay_payment_id: `test_pay_${Date.now()}`,
        status: "active",
        started_at: startTime.toISOString(),
        expires_at: expiresTime.toISOString(),
      })
      .select()
      .single();

    if (error) {
      logger.error({ error }, "Failed to create test subscription");
      return reply.status(500).send({ error: "Failed to activate test subscription" });
    }

    return reply.status(201).send({
      success: true,
      message: `[TEST] Recharge activated! Valid until ${expiresTime.toLocaleString()}.`,
      subscription: sub,
    });
  });

  /**
   * GET /subscriptions/history — Get driver's past purchased subscriptions
   */
  app.get("/subscriptions/history", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const now = Date.now();
    const nowIso = new Date().toISOString();

    // Auto-expire all past active subscriptions for this driver in the database
    await supabaseAdmin
      .from("driver_subscriptions")
      .update({ status: "expired", updated_at: nowIso })
      .eq("driver_id", driverId)
      .eq("status", "active")
      .lte("expires_at", nowIso);

    const { data: history, error } = await supabaseAdmin
      .from("driver_subscriptions")
      .select("*")
      .eq("driver_id", driverId)
      .neq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      logger.error({ error, driverId }, "Failed to fetch subscription history");
      return reply.status(500).send({ error: "Failed to fetch history" });
    }

    const sanitizedHistory = (history || []).map((item) => {
      if (item.status === "active" && item.expires_at && now >= new Date(item.expires_at).getTime()) {
        return { ...item, status: "expired" };
      }
      return item;
    });

    return reply.send({
      history: sanitizedHistory,
    });
  });
}
