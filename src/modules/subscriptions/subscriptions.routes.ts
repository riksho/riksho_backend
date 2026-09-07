import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js";
import { logger } from "../../common/logger.js";
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
  fetchRazorpayOrder,
  verifyRazorpayWebhookSignature,
  generateUpiIntentUrl,
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

const CheckOrderStatusSchema = z.object({
  order_id: z.string().optional(),
});

const TestActivateSchema = z.object({
  plan_id: z.string().optional(),
  duration_hours: z.number().int().positive().optional(),
});

/**
 * Shared, idempotent helper to activate a driver's subscription once payment is confirmed
 */
export async function activateSubscriptionByOrder(
  razorpayOrderId: string,
  razorpayPaymentId?: string,
  explicitDriverId?: string
) {
  let query = supabaseAdmin
    .from("driver_subscriptions")
    .select("*")
    .eq("razorpay_order_id", razorpayOrderId);

  if (explicitDriverId) {
    query = query.eq("driver_id", explicitDriverId);
  }

  const { data: sub } = await query.maybeSingle();

  if (!sub) {
    logger.warn({ razorpayOrderId, explicitDriverId }, "No subscription found for order");
    return null;
  }

  // Idempotency: If already active and unexpired, return immediately
  if (sub.status === "active") {
    const now = Date.now();
    const expiresTime = new Date(sub.expires_at).getTime();
    if (expiresTime > now) {
      return sub;
    }
  }

  const driverId = sub.driver_id;
  const durationHours = sub.duration_hours || 24;
  const paymentIdToSave = razorpayPaymentId || sub.razorpay_payment_id || `pay_${Date.now()}`;

  // Check if discount was applied and deduct from promo balance
  if (sub.plan_id) {
    let planPrice = 0;
    const { data: planRow } = await supabaseAdmin
      .from("subscription_plans")
      .select("price")
      .eq("id", sub.plan_id)
      .maybeSingle();

    if (planRow) {
      planPrice = planRow.price;
    } else {
      const fb = findFallbackPlanById(sub.plan_id);
      if (fb) planPrice = fb.price;
    }

    if (planPrice > (sub.amount_paid || 0)) {
      const discountUsedRs = (planPrice - (sub.amount_paid || 0)) / 100;
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
    .neq("id", sub.id)
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

  const { data: updatedSub, error: updateError } = await supabaseAdmin
    .from("driver_subscriptions")
    .update({
      razorpay_payment_id: paymentIdToSave,
      status: "active",
      started_at: startTime.toISOString(),
      expires_at: expiresTime.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id)
    .select()
    .single();

  if (updateError) {
    logger.error({ updateError, subId: sub.id }, "Failed to update driver subscription to active");
    return null;
  }

  logger.info(
    { driverId, subId: sub.id, orderId: razorpayOrderId, expires_at: expiresTime.toISOString() },
    "Successfully activated driver subscription"
  );

  return updatedSub;
}

export const DEFAULT_VEHICLE_FALLBACK_PLANS: Record<string, any[]> = {
  auto: [
    {
      id: "10000000-0000-0000-0000-000000000001",
      name: "Auto 24h Daily Pass",
      vehicle_type: "auto",
      duration_hours: 24,
      original_price: 2000,
      price: 1500,
      badge: "popular",
      discount_label: "25% OFF",
      description: "40% cheaper than Namma Yatri (₹25/day)",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 1,
    },
    {
      id: "10000000-0000-0000-0000-000000000002",
      name: "Auto 7-Day Weekly Pass",
      vehicle_type: "auto",
      duration_hours: 168,
      original_price: 14000,
      price: 7900,
      badge: "best_value",
      discount_label: "44% OFF",
      description: "~₹11.28/day (Saves ₹26 vs 7 daily passes)",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 2,
    },
    {
      id: "10000000-0000-0000-0000-000000000003",
      name: "Auto 3-Day Saver Pack",
      vehicle_type: "auto",
      duration_hours: 72,
      original_price: 3500,
      price: 2000,
      badge: "saver_pack",
      discount_label: "43% OFF",
      description: "Ideal for part-time / morning shift autos (12 rides)",
      max_rides: 12,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 3,
    },
  ],
  e_rickshaw: [
    {
      id: "20000000-0000-0000-0000-000000000001",
      name: "Toto 24h Daily Pass",
      vehicle_type: "e_rickshaw",
      duration_hours: 24,
      original_price: 1500,
      price: 1000,
      badge: "popular",
      discount_label: "33% OFF",
      description: "Most affordable daily pass for green drivers",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 1,
    },
    {
      id: "20000000-0000-0000-0000-000000000002",
      name: "Toto 7-Day Weekly Pass",
      vehicle_type: "e_rickshaw",
      duration_hours: 168,
      original_price: 8000,
      price: 4500,
      badge: "best_value",
      discount_label: "44% OFF",
      description: "~₹6.42/day unlimited hyperlocal earnings",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 2,
    },
    {
      id: "20000000-0000-0000-0000-000000000003",
      name: "Toto 3-Day Saver Pack",
      vehicle_type: "e_rickshaw",
      duration_hours: 72,
      original_price: 3000,
      price: 1500,
      badge: "saver_pack",
      discount_label: "50% OFF",
      description: "₹1 per trip flat — maximum flexibility (15 rides)",
      max_rides: 15,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 3,
    },
  ],
  bike: [
    {
      id: "30000000-0000-0000-0000-000000000001",
      name: "Bike 24h Daily Pass",
      vehicle_type: "bike",
      duration_hours: 24,
      original_price: 1500,
      price: 1000,
      badge: "popular",
      discount_label: "33% OFF",
      description: "Half price of Rapido Captain (₹20/day)",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 1,
    },
    {
      id: "30000000-0000-0000-0000-000000000002",
      name: "Bike 7-Day Weekly Pass",
      vehicle_type: "bike",
      duration_hours: 168,
      original_price: 9000,
      price: 4900,
      badge: "best_value",
      discount_label: "46% OFF",
      description: "~₹7.00/day unlimited rides",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 2,
    },
    {
      id: "30000000-0000-0000-0000-000000000003",
      name: "Bike 10 Rides Lite Pack",
      vehicle_type: "bike",
      duration_hours: 72,
      original_price: 2500,
      price: 1900,
      badge: "saver_pack",
      discount_label: "24% OFF",
      description: "Perfect for student / gig riders (10 rides)",
      max_rides: 10,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 3,
    },
    {
      id: "30000000-0000-0000-0000-000000000004",
      name: "Bike 30 Rides Power Pack",
      vehicle_type: "bike",
      duration_hours: 120,
      original_price: 3500,
      price: 2500,
      badge: "power_pack",
      discount_label: "28% OFF",
      description: "Peak rush-hour warriors (30 rides)",
      max_rides: 30,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 4,
    },
  ],
  cab: [
    {
      id: "40000000-0000-0000-0000-000000000001",
      name: "Cab Monthly Milestone Pass",
      vehicle_type: "cab",
      duration_hours: 720,
      original_price: 50000,
      price: 44900,
      badge: "best_value",
      discount_label: "100% FREE UPFRONT",
      description: "Free access until ₹12,000 earned, then ₹449 flat SaaS pass",
      max_rides: null,
      is_milestone_plan: true,
      milestone_threshold: 12000.0,
      is_active: true,
      sort_order: 1,
    },
    {
      id: "40000000-0000-0000-0000-000000000002",
      name: "Cab 7-Day Weekly Flex",
      vehicle_type: "cab",
      duration_hours: 168,
      original_price: 15000,
      price: 11900,
      badge: "weekly_flex",
      discount_label: "21% OFF",
      description: "Flexible weekly pass without monthly lock-in",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 2,
    },
    {
      id: "40000000-0000-0000-0000-000000000003",
      name: "Cab 24h Daily Flex Pass",
      vehicle_type: "cab",
      duration_hours: 24,
      original_price: 2500,
      price: 1900,
      badge: "daily_flex",
      discount_label: "24% OFF",
      description: "For occasional weekend cab drivers",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 3,
    },
  ],
  cargo: [
    {
      id: "50000000-0000-0000-0000-000000000001",
      name: "Cargo 24h Daily Pass",
      vehicle_type: "cargo",
      duration_hours: 24,
      original_price: 2500,
      price: 1500,
      badge: "popular",
      discount_label: "40% OFF",
      description: "Unlimited intra-city deliveries for 24 hours",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 1,
    },
    {
      id: "50000000-0000-0000-0000-000000000002",
      name: "Cargo 7-Day Weekly Pass",
      vehicle_type: "cargo",
      duration_hours: 168,
      original_price: 15000,
      price: 8900,
      badge: "best_value",
      discount_label: "41% OFF",
      description: "High-volume commercial deliveries pass",
      max_rides: null,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 2,
    },
    {
      id: "50000000-0000-0000-0000-000000000003",
      name: "Cargo 15 Trips Saver Pack",
      vehicle_type: "cargo",
      duration_hours: 72,
      original_price: 4000,
      price: 2500,
      badge: "saver_pack",
      discount_label: "38% OFF",
      description: "On-demand freight hauling saver pack (15 trips)",
      max_rides: 15,
      is_milestone_plan: false,
      milestone_threshold: null,
      is_active: true,
      sort_order: 3,
    },
  ],
};

export const ALL_FALLBACK_PLANS = Object.values(DEFAULT_VEHICLE_FALLBACK_PLANS).flat();

export function normalizeVehicleType(type?: string | null): string {
  if (!type) return "auto";
  const t = type.toLowerCase().trim();
  if (t === "toto" || t === "e_rickshaw" || t === "erickshaw") return "e_rickshaw";
  if (t === "bike" || t === "motorcycle" || t === "scooter") return "bike";
  if (t === "car" || t === "cab" || t === "sedan" || t === "hatchback") return "cab";
  if (t === "cargo" || t === "tempo" || t === "mini_truck" || t === "truck") return "cargo";
  return "auto";
}

export function findFallbackPlanById(planId: string): any | undefined {
  return ALL_FALLBACK_PLANS.find((p) => p.id === planId);
}

export async function subscriptionsRoutes(app: FastifyInstance) {
  /**
   * GET /subscriptions/plans — List active subscription recharge plans filtered by vehicle type
   */
  app.get("/subscriptions/plans", async (request, reply) => {
    const query = request.query as { vehicle_type?: string };
    const normType = query.vehicle_type ? normalizeVehicleType(query.vehicle_type) : "auto";

    const { data: plans, error } = await supabaseAdmin
      .from("subscription_plans")
      .select("*")
      .eq("is_active", true)
      .eq("vehicle_type", normType)
      .order("sort_order", { ascending: true });

    if (error) {
      logger.error({ error, vehicle_type: normType }, "Failed to fetch subscription plans");
      const fallback = DEFAULT_VEHICLE_FALLBACK_PLANS[normType] || DEFAULT_VEHICLE_FALLBACK_PLANS.auto;
      return reply.send({ plans: fallback, razorpay_key_id: RAZORPAY_KEY_ID });
    }

    // Default fallback plans if table is not yet seeded for this vehicle type
    if (!plans || plans.length === 0) {
      const fallback = DEFAULT_VEHICLE_FALLBACK_PLANS[normType] || DEFAULT_VEHICLE_FALLBACK_PLANS.auto;
      return reply.send({ plans: fallback, razorpay_key_id: RAZORPAY_KEY_ID });
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

    let { data: sub, error } = await supabaseAdmin
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

    // Auto-reconcile check: if no active subscription, check for recent pending order (within 30 mins)
    if (!sub) {
      const thirtyMinsAgo = new Date(now - 30 * 60 * 1000).toISOString();
      const { data: recentPending } = await supabaseAdmin
        .from("driver_subscriptions")
        .select("*")
        .eq("driver_id", driverId)
        .eq("status", "pending")
        .gte("created_at", thirtyMinsAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recentPending?.razorpay_order_id) {
        try {
          const rzpOrder = await fetchRazorpayOrder(recentPending.razorpay_order_id);
          if (rzpOrder && (rzpOrder.status === "paid" || rzpOrder.amount_paid > 0)) {
            sub = await activateSubscriptionByOrder(
              recentPending.razorpay_order_id,
              rzpOrder.payment_id,
              driverId
            );
          }
        } catch (e: any) {
          logger.warn({ err: e.message }, "Background order reconciliation check failed");
        }
      }
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

    const fallbackMatch = findFallbackPlanById(plan_id);
    let planName = fallbackMatch?.name || "Driver Pass";
    let durationHours = fallbackMatch?.duration_hours || 24;
    let pricePaise = fallbackMatch?.price || 1500;
    let vehicleType = fallbackMatch?.vehicle_type || "all";
    let maxRides = fallbackMatch?.max_rides ?? null;
    let isMilestonePlan = fallbackMatch?.is_milestone_plan ?? false;
    let milestoneThreshold = fallbackMatch?.milestone_threshold ?? null;

    if (!planErr && plan) {
      planName = plan.name;
      durationHours = plan.duration_hours;
      pricePaise = plan.price;
      vehicleType = plan.vehicle_type || "all";
      maxRides = plan.max_rides ?? null;
      isMilestonePlan = plan.is_milestone_plan ?? false;
      milestoneThreshold = plan.milestone_threshold ?? null;
    }

    // If milestone plan with free upfront (e.g. Cab ₹12k milestone)
    if (isMilestonePlan && pricePaise === 0) {
      pricePaise = 0;
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

    // If 100% covered by promo balance / 0 payable (or free upfront milestone) -> activate immediately without Razorpay!
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
          vehicle_type: vehicleType,
          max_rides: maxRides,
          is_milestone_plan: isMilestonePlan,
          milestone_threshold: milestoneThreshold,
          amount_paid: 0,
          razorpay_order_id: isMilestonePlan ? `milestone_free_${Date.now()}` : `promo_covered_${Date.now()}`,
          razorpay_payment_id: isMilestonePlan ? `milestone_free_${Date.now()}` : `promo_pay_${Date.now()}`,
          status: "active",
          started_at: startTime.toISOString(),
          expires_at: expiresTime.toISOString(),
        })
        .select()
        .single();

      return reply.status(201).send({
        success: true,
        free_activated: true,
        message: isMilestonePlan
          ? `Milestone pass activated with ₹0 upfront! Free up to ₹${milestoneThreshold?.toLocaleString() || "12,000"}.`
          : `Pass activated using ₹${usedRs.toFixed(0)} promo balance!`,
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
          vehicle_type: vehicleType,
          max_rides: maxRides,
          is_milestone_plan: isMilestonePlan,
          milestone_threshold: milestoneThreshold,
          amount_paid: payablePaise,
          razorpay_order_id: order.id,
          status: "pending",
        })
        .select()
        .single();

      if (insertErr) {
        logger.error({ insertErr }, "Failed to record pending subscription");
      }

      const upiIntentUrl = generateUpiIntentUrl({
        orderId: order.id,
        amountPaise: payablePaise,
        planName: planName,
      });

      return reply.status(201).send({
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        razorpay_key_id: RAZORPAY_KEY_ID,
        upi_intent_url: upiIntentUrl,
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

    const updatedSub = await activateSubscriptionByOrder(
      razorpay_order_id,
      razorpay_payment_id,
      driverId
    );

    if (!updatedSub) {
      return reply.status(500).send({ error: "Failed to activate subscription." });
    }

    return reply.send({
      success: true,
      message: `Recharge successful! Active for ${updatedSub.duration_hours || 24} hours.`,
      subscription: updatedSub,
    });
  });

  /**
   * POST /subscriptions/check-order-status — Reconcile order status directly against Razorpay API
   * Used when returning from external UPI apps (GPay, PhonePe) or upon app resume.
   */
  app.post("/subscriptions/check-order-status", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const { order_id } = CheckOrderStatusSchema.parse(request.body || {});

    let targetOrderId = order_id;

    if (!targetOrderId) {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data: pendingSub } = await supabaseAdmin
        .from("driver_subscriptions")
        .select("razorpay_order_id")
        .eq("driver_id", driverId)
        .eq("status", "pending")
        .gte("created_at", thirtyMinsAgo)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (pendingSub?.razorpay_order_id) {
        targetOrderId = pendingSub.razorpay_order_id;
      }
    }

    if (!targetOrderId) {
      return reply.send({
        checked: false,
        active: false,
        message: "No recent pending order found to check.",
      });
    }

    // 1. Check if already marked active
    const { data: existingSub } = await supabaseAdmin
      .from("driver_subscriptions")
      .select("*")
      .eq("razorpay_order_id", targetOrderId)
      .eq("driver_id", driverId)
      .maybeSingle();

    if (existingSub && existingSub.status === "active") {
      return reply.send({
        checked: true,
        active: true,
        subscription: existingSub,
        message: "Subscription is already active.",
      });
    }

    // 2. Query Razorpay API directly
    const rzpOrder = await fetchRazorpayOrder(targetOrderId);
    if (!rzpOrder) {
      return reply.send({
        checked: true,
        active: false,
        message: "Order details could not be retrieved from Razorpay.",
      });
    }

    // 3. If paid on Razorpay, activate immediately
    if (rzpOrder.status === "paid" || rzpOrder.amount_paid > 0) {
      const activatedSub = await activateSubscriptionByOrder(
        targetOrderId,
        rzpOrder.payment_id,
        driverId
      );

      return reply.send({
        checked: true,
        active: true,
        subscription: activatedSub,
        message: "Payment confirmed on Razorpay! Pass activated successfully.",
      });
    }

    return reply.send({
      checked: true,
      active: false,
      order_status: rzpOrder.status,
      message: `Payment status on Razorpay is currently: ${rzpOrder.status}`,
    });
  });

  /**
   * POST /subscriptions/razorpay-webhook — Server-to-server webhook handler from Razorpay
   */
  app.post("/subscriptions/razorpay-webhook", async (request, reply) => {
    const signature = (request.headers["x-razorpay-signature"] as string) || "";
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);

    const isValid = verifyRazorpayWebhookSignature(rawBody, signature);
    if (!isValid) {
      logger.warn({ signature }, "Invalid Razorpay webhook signature");
      return reply.status(400).send({ error: "INVALID_SIGNATURE" });
    }

    const payload = typeof request.body === "object" ? (request.body as any) : JSON.parse(rawBody || "{}");
    const event = payload.event;
    logger.info({ event }, "Received Razorpay webhook event");

    if (event === "order.paid" || event === "payment.captured") {
      const orderEntity = payload.payload?.order?.entity || payload.payload?.payment?.entity;
      const orderId = orderEntity?.order_id || orderEntity?.id;
      const paymentId = payload.payload?.payment?.entity?.id || orderEntity?.payment_id;

      if (orderId) {
        const activated = await activateSubscriptionByOrder(orderId, paymentId);
        logger.info({ orderId, activated: !!activated }, "Webhook processed subscription activation");
      }
    }

    return reply.status(200).send({ status: "ok" });
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
