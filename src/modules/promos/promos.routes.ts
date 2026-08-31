import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { logger } from "../../common/logger.js";

const RedeemPromoSchema = z.object({
  code: z.string().min(1, "Please enter a promo code").max(6, "Promo code cannot exceed 6 characters"),
});

const CreatePromoSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(6, "Promo code cannot exceed 6 characters"),
  type: z.enum(["credit", "free_pass"]).optional().default("credit"),
  amount: z.number().min(0, "Amount cannot be negative").optional().default(0),
  duration_days: z.number().int().positive("Duration must be at least 1 day").nullable().optional(),
  plan_name: z.string().max(100).nullable().optional(),
  max_redemptions: z.number().int().positive().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  usage_validity_hours: z.number().int().positive().nullable().optional(),
  description: z.string().max(255).optional(),
  is_active: z.boolean().optional().default(true),
});

const UpdatePromoSchema = z.object({
  is_active: z.boolean().optional(),
  type: z.enum(["credit", "free_pass"]).optional(),
  amount: z.number().min(0).optional(),
  duration_days: z.number().int().positive().nullable().optional(),
  plan_name: z.string().max(100).nullable().optional(),
  max_redemptions: z.number().int().positive().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  usage_validity_hours: z.number().int().positive().nullable().optional(),
  description: z.string().max(255).optional(),
});

export async function promosRoutes(app: FastifyInstance) {
  /**
   * ==========================================
   * DRIVER PROMO ENDPOINTS
   * ==========================================
   */

  /**
   * GET /promos/balance — Fetch current driver usable balance
   */
  app.get("/promos/balance", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;

    const { data: driver, error } = await supabaseAdmin
      .from("drivers")
      .select("coupon_balance")
      .eq("id", driverId)
      .maybeSingle();

    if (error) {
      logger.error({ error, driverId }, "Failed to fetch driver balance");
      return reply.status(500).send({ error: "Failed to fetch balance" });
    }

    return reply.send({
      coupon_balance: Number(driver?.coupon_balance || 0),
    });
  });

  /**
   * POST /promos/redeem — Redeem a promo code for credit or a free access pass
   */
  app.post("/promos/redeem", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const parsed = RedeemPromoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Promo codes must be up to 6 characters (letters, numbers, symbols).",
      });
    }

    const code = parsed.data.code.trim().toUpperCase();

    // 1. Fetch promo code details
    const { data: promo, error: promoError } = await supabaseAdmin
      .from("driver_promo_codes")
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (promoError) {
      logger.error({ error: promoError, code }, "Failed to query promo code");
      return reply.status(400).send({ error: "Could not validate promo code. Please try again." });
    }

    // Built-in hardcoded fallback for common test vouchers (up to 6 chars)
    if (!promo) {
      if (code === "RIK100" || code === "RIKSHO" || code === "FREE07" || code === "WEL100") {
        const reward = code === "FREE07" ? 49 : code === "RIKSHO" ? 50 : 100;
        
        const { data: driver } = await supabaseAdmin
          .from("drivers")
          .select("coupon_balance")
          .eq("id", driverId)
          .maybeSingle();

        const currentBal = Number(driver?.coupon_balance || 0);
        const newBal = currentBal + reward;

        await supabaseAdmin
          .from("drivers")
          .update({ coupon_balance: newBal })
          .eq("id", driverId);

        return reply.send({
          success: true,
          type: "credit",
          amount: reward,
          new_balance: newBal,
          message: `₹${reward} credit added to your usable balance.`,
        });
      }

      return reply.status(400).send({
        error: "Invalid promo code. Please check and try again.",
      });
    }

    // 2. Check if promo is active or discontinued
    if (!promo.is_active || promo.is_deleted) {
      return reply.status(400).send({
        error: "This promo code is no longer active.",
      });
    }

    // 3. Check expiration
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return reply.status(400).send({
        error: "This promo code has expired.",
      });
    }

    // 4. Check max redemption capacity
    if (promo.max_redemptions && promo.redemption_count >= promo.max_redemptions) {
      return reply.status(400).send({
        error: "This promo code has reached its maximum redemption limit.",
      });
    }

    // 5. Check if this driver already redeemed this promo
    const { data: existingRedemption } = await supabaseAdmin
      .from("driver_promo_redemptions")
      .select("id")
      .eq("promo_code_id", promo.id)
      .eq("driver_id", driverId)
      .maybeSingle();

    if (existingRedemption) {
      return reply.status(400).send({
        error: "You have already redeemed this promo code.",
      });
    }

    const promoType = promo.type || "credit";

    // 6. Handle Type: Free Subscription Access Pass (Days)
    if (promoType === "free_pass") {
      const days = Number(promo.duration_days) || 1;
      const durationHours = days * 24;
      const planTitle = promo.plan_name || `Free ${days}-Day Promo Pass`;

      // Check if driver has an existing active subscription -> stack duration
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

      // Insert active free subscription pass
      const { data: newSub, error: subErr } = await supabaseAdmin
        .from("driver_subscriptions")
        .insert({
          driver_id: driverId,
          plan_name: planTitle,
          duration_hours: durationHours,
          amount_paid: 0,
          status: "active",
          started_at: startTime.toISOString(),
          expires_at: expiresTime.toISOString(),
        })
        .select()
        .single();

      if (subErr) {
        logger.error({ subErr }, "Failed to activate free pass subscription");
        return reply.status(500).send({ error: "Failed to activate free access pass." });
      }

      // Record redemption audit
      await supabaseAdmin.from("driver_promo_redemptions").insert({
        promo_code_id: promo.id,
        driver_id: driverId,
        code: promo.code,
        amount: 0,
        type: "free_pass",
        duration_days: days,
        subscription_id: newSub?.id,
      });

      // Increment redemption count
      await supabaseAdmin
        .from("driver_promo_codes")
        .update({
          redemption_count: (promo.redemption_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", promo.id);

      logger.info({ driverId, code, days, expiresTime }, "Driver redeemed free access pass promo code");

      return reply.send({
        success: true,
        type: "free_pass",
        duration_days: days,
        plan_name: planTitle,
        expires_at: expiresTime.toISOString(),
        message: `Free ${days}-day pass activated! You now have unlimited access to drive.`,
      });
    }

    // 7. Handle Type: Usable Balance Credit (₹)
    const rewardAmount = Number(promo.amount || 0);

    // Record redemption
    const { error: insertRedemptionErr } = await supabaseAdmin
      .from("driver_promo_redemptions")
      .insert({
        promo_code_id: promo.id,
        driver_id: driverId,
        code: promo.code,
        amount: rewardAmount,
        type: "credit",
      });

    if (insertRedemptionErr) {
      logger.error({ error: insertRedemptionErr }, "Failed to record promo redemption");
      return reply.status(500).send({ error: "Failed to redeem promo code." });
    }

    // Increment redemption count
    await supabaseAdmin
      .from("driver_promo_codes")
      .update({
        redemption_count: (promo.redemption_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", promo.id);

    // Update driver's usable coupon_balance
    const { data: driverData } = await supabaseAdmin
      .from("drivers")
      .select("coupon_balance")
      .eq("id", driverId)
      .maybeSingle();

    const currentBalance = Number(driverData?.coupon_balance || 0);
    const newBalance = currentBalance + rewardAmount;

    await supabaseAdmin
      .from("drivers")
      .update({ coupon_balance: newBalance })
      .eq("id", driverId);

    logger.info({ driverId, code, rewardAmount, newBalance }, "Driver redeemed credit promo code");

    return reply.send({
      success: true,
      type: "credit",
      amount: rewardAmount,
      new_balance: newBalance,
      message: `₹${rewardAmount} credit added to your usable balance.`,
    });
  });

  /**
   * ==========================================
   * ADMIN PROMO MANAGEMENT ENDPOINTS
   * ==========================================
   */
  const adminGuard = { preHandler: [authGuard, requireRole("admin")] };

  /**
   * GET /admin/promos — List all promo codes with stats
   */
  app.get("/admin/promos", adminGuard, async (request, reply) => {
    const { data: promos, error } = await supabaseAdmin
      .from("driver_promo_codes")
      .select("*")
      .or("is_deleted.is.null,is_deleted.eq.false")
      .order("created_at", { ascending: false });

    if (error) {
      logger.error({ error }, "Failed to fetch admin promo codes");
      return reply.status(500).send({ error: "Failed to fetch promo codes" });
    }

    const promoList = promos || [];
    const totalCodes = promoList.length;
    const activeCodes = promoList.filter((p) => p.is_active && !p.is_deleted).length;
    const totalRedemptions = promoList.reduce((sum, p) => sum + (p.redemption_count || 0), 0);
    const totalValueDistributed = promoList.reduce(
      (sum, p) => sum + (p.redemption_count || 0) * Number(p.amount || 0),
      0
    );

    return reply.send({
      promos: promoList,
      stats: {
        total_codes: totalCodes,
        active_codes: activeCodes,
        total_redemptions: totalRedemptions,
        total_value_distributed: totalValueDistributed,
      },
    });
  });

  /**
   * POST /admin/promos — Create a new promo code (Credit ₹ OR Free Access Pass Days)
   */
  app.post("/admin/promos", adminGuard, async (request, reply) => {
    const adminId = request.user!.id;
    const body = CreatePromoSchema.parse(request.body);
    const code = body.code.trim().toUpperCase();

    // Check if active code already exists
    const { data: existing } = await supabaseAdmin
      .from("driver_promo_codes")
      .select("id, is_deleted")
      .eq("code", code)
      .maybeSingle();

    if (existing && !existing.is_deleted) {
      return reply.status(400).send({
        error: `Promo code "${code}" already exists. Please choose a different code.`,
      });
    }

    const isFreePass = body.type === "free_pass";
    const durationDays = isFreePass ? body.duration_days || 7 : null;
    const planName = isFreePass ? body.plan_name?.trim() || `Free ${durationDays}-Day Pass` : null;
    const amount = isFreePass ? 0 : body.amount;

    let newPromo;
    if (existing && existing.is_deleted) {
      // Re-activate and overwrite previously deleted code
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("driver_promo_codes")
        .update({
          type: body.type || "credit",
          amount,
          duration_days: durationDays,
          plan_name: planName,
          max_redemptions: body.max_redemptions || null,
          expires_at: body.expires_at || null,
          description: body.description?.trim() || null,
          is_active: body.is_active ?? true,
          is_deleted: false,
          deleted_at: null,
          created_by: adminId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (updateErr) {
        logger.error({ error: updateErr }, "Failed to reactivate promo code");
        return reply.status(500).send({ error: "Failed to create promo code" });
      }
      newPromo = updated;
    } else {
      const { data: created, error: insertErr } = await supabaseAdmin
        .from("driver_promo_codes")
        .insert({
          code,
          type: body.type || "credit",
          amount,
          duration_days: durationDays,
          plan_name: planName,
          max_redemptions: body.max_redemptions || null,
          expires_at: body.expires_at || null,
          description: body.description?.trim() || null,
          is_active: body.is_active ?? true,
          is_deleted: false,
          created_by: adminId,
        })
        .select()
        .single();

      if (insertErr) {
        logger.error({ error: insertErr, body }, "Failed to create admin promo code");
        return reply.status(500).send({ error: "Failed to create promo code" });
      }
      newPromo = created;
    }

    logger.info({ adminId, code: newPromo.code, type: newPromo.type }, "Admin created promo code");
    return reply.status(201).send({ promo: newPromo });
  });

  /**
   * PATCH /admin/promos/:id — Update promo code
   */
  app.patch("/admin/promos/:id", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = UpdatePromoSchema.parse(request.body);

    const updatePayload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof body.is_active === "boolean") updatePayload.is_active = body.is_active;
    if (body.type !== undefined) updatePayload.type = body.type;
    if (typeof body.amount === "number") updatePayload.amount = body.amount;
    if (body.duration_days !== undefined) updatePayload.duration_days = body.duration_days;
    if (body.plan_name !== undefined) updatePayload.plan_name = body.plan_name?.trim() || null;
    if (body.max_redemptions !== undefined) updatePayload.max_redemptions = body.max_redemptions;
    if (body.expires_at !== undefined) updatePayload.expires_at = body.expires_at;
    if (body.description !== undefined) updatePayload.description = body.description?.trim() || null;

    const { data: updated, error } = await supabaseAdmin
      .from("driver_promo_codes")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      logger.error({ error, id }, "Failed to update promo code");
      return reply.status(500).send({ error: "Failed to update promo code" });
    }

    return reply.send({ promo: updated });
  });

  /**
   * DELETE /admin/promos/:id — Delete a promo code
   * Soft-deletes to block new redemptions while preserving redemption history and ongoing driver access validity.
   */
  app.delete("/admin/promos/:id", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };

    const { data: updated, error } = await supabaseAdmin
      .from("driver_promo_codes")
      .update({
        is_active: false,
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      logger.error({ error, id }, "Failed to delete promo code");
      return reply.status(500).send({ error: "Failed to delete promo code" });
    }

    logger.info({ id, code: updated?.code }, "Admin deleted promo code");
    return reply.send({
      success: true,
      message: `Promo code "${updated?.code || id}" deleted successfully. New claims are now blocked; existing active driver benefits remain valid until expiry.`,
      promo: updated,
    });
  });

  /**
   * ==========================================
   * CUSTOMER COIN PROMO ENDPOINTS
   * (Strictly 6 characters, gives coins only)
   * ==========================================
   */

  /**
   * GET /customer/coins/balance — Fetch customer's current coin balance and history
   */
  app.get("/customer/coins/balance", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;

    // 1. Fetch user coins_balance
    const { data: user, error: userErr } = await supabaseAdmin
      .from("users")
      .select("coins_balance")
      .eq("id", userId)
      .maybeSingle();

    if (userErr) {
      logger.error({ error: userErr, userId }, "Failed to fetch user coin balance");
    }

    // 2. Fetch redemptions history
    const { data: redemptions, error: redemptionsErr } = await supabaseAdmin
      .from("customer_coin_promo_redemptions")
      .select("id, code, coins_amount, redeemed_at")
      .eq("user_id", userId)
      .order("redeemed_at", { ascending: false });

    return reply.send({
      coins_balance: Number(user?.coins_balance || 0),
      redemptions: redemptions || [],
    });
  });

  /**
   * POST /customer/promos/redeem — Redeem a 6-character promo code for Riksho Coins
   */
  app.post("/customer/promos/redeem", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const parsed = z.object({
      code: z.string().trim().length(6, "Promo code must be strictly 6 characters"),
    }).safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Promo code must be strictly 6 characters (e.g. COIN50, RIKSHO, WEL100).",
      });
    }

    const code = parsed.data.code.toUpperCase();

    // 1. Fetch promo code details
    const { data: promo, error: promoError } = await supabaseAdmin
      .from("customer_coin_promo_codes")
      .select("*")
      .eq("code", code)
      .eq("is_deleted", false)
      .maybeSingle();

    let coinsAmount = 0;
    let promoId: string | null = null;

    if (promo) {
      if (!promo.is_active) {
        return reply.status(400).send({ error: "This promo code is no longer active." });
      }

      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return reply.status(400).send({ error: "This promo code has expired." });
      }

      if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
        return reply.status(400).send({ error: "This promo code has reached its maximum redemptions limit." });
      }

      coinsAmount = promo.coins_amount;
      promoId = promo.id;
    } else {
      // Hardcoded fallback standard codes (all 6 chars)
      if (code === "RIKSHO") {
        coinsAmount = 50;
      } else if (code === "COIN50") {
        coinsAmount = 50;
      } else if (code === "WEL100") {
        coinsAmount = 100;
      } else {
        return reply.status(404).send({ error: "Invalid promo code. Please check and try again." });
      }
    }

    // 2. Check if user has already redeemed this code
    if (promoId) {
      const { data: existing } = await supabaseAdmin
        .from("customer_coin_promo_redemptions")
        .select("id")
        .eq("promo_code_id", promoId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        return reply.status(400).send({ error: "You have already redeemed this promo code." });
      }
    }

    // 3. Fetch current user balance
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("coins_balance")
      .eq("id", userId)
      .maybeSingle();

    const currentBalance = Number(user?.coins_balance || 0);
    const newBalance = currentBalance + coinsAmount;

    // 4. Update coins balance on users table
    const { error: userUpdateErr } = await supabaseAdmin
      .from("users")
      .update({ coins_balance: newBalance })
      .eq("id", userId);

    if (userUpdateErr) {
      logger.error({ error: userUpdateErr, userId }, "Failed to update user coin balance");
    }

    // 5. Record redemption & increment count if promo exists in DB
    if (promoId) {
      await supabaseAdmin.from("customer_coin_promo_redemptions").insert({
        promo_code_id: promoId,
        user_id: userId,
        code,
        coins_amount: coinsAmount,
      });

      await supabaseAdmin
        .from("customer_coin_promo_codes")
        .update({
          redemption_count: (promo.redemption_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", promoId);
    }

    logger.info({ userId, code, coinsAmount, newBalance }, "Customer redeemed coin promo code");

    return reply.send({
      success: true,
      code,
      coins_awarded: coinsAmount,
      coins_balance: newBalance,
      message: `🎉 Success! +${coinsAmount} Riksho Coins added to your account!`,
    });
  });

  /**
   * GET /admin/customer-promos — List all customer coin promo codes
   */
  app.get("/admin/customer-promos", adminGuard, async (request, reply) => {
    const { data: promos, error } = await supabaseAdmin
      .from("customer_coin_promo_codes")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      logger.error({ error }, "Failed to fetch customer promo codes");
      return reply.status(500).send({ error: "Failed to fetch customer promo codes" });
    }

    const nonDeleted = (promos || []).filter((p) => !p.is_deleted);
    const totalCodes = nonDeleted.length;
    const activeCodes = nonDeleted.filter((p) => p.is_active).length;
    const totalRedemptions = nonDeleted.reduce((sum, p) => sum + (p.redemption_count || 0), 0);
    const totalCoinsDistributed = nonDeleted.reduce(
      (sum, p) => sum + (p.redemption_count || 0) * Number(p.coins_amount || 0),
      0
    );

    return reply.send({
      promos: promos || [],
      stats: {
        total_codes: totalCodes,
        active_codes: activeCodes,
        total_redemptions: totalRedemptions,
        total_coins_distributed: totalCoinsDistributed,
      },
    });
  });

  /**
   * POST /admin/customer-promos — Create new customer coin promo code (strict 6 chars)
   */
  app.post("/admin/customer-promos", adminGuard, async (request, reply) => {
    const parsed = z.object({
      code: z.string().trim().length(6, "Customer promo code must be strictly 6 characters"),
      coins_amount: z.number().int().positive("Coins amount must be greater than 0"),
      max_redemptions: z.number().int().positive().nullable().optional(),
      expires_at: z.string().datetime().nullable().optional(),
      usage_validity_hours: z.number().int().positive().nullable().optional(),
      description: z.string().max(255).optional(),
      is_active: z.boolean().optional().default(true),
    }).safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message || "Customer promo code must be strictly 6 characters",
      });
    }

    const { code, coins_amount, max_redemptions, expires_at, usage_validity_hours, description, is_active } = parsed.data;
    const upperCode = code.toUpperCase();

    // Check if code already exists
    const { data: existing } = await supabaseAdmin
      .from("customer_coin_promo_codes")
      .select("id, is_deleted")
      .eq("code", upperCode)
      .maybeSingle();

    if (existing && !existing.is_deleted) {
      return reply.status(400).send({ error: `Promo code "${upperCode}" already exists.` });
    }

    const payload = {
      code: upperCode,
      coins_amount,
      max_redemptions: max_redemptions || null,
      expires_at: expires_at || null,
      usage_validity_hours: usage_validity_hours || null,
      description: description?.trim() || null,
      is_active: is_active ?? true,
      is_deleted: false,
      deleted_at: null,
      created_by: request.user?.id || null,
      updated_at: new Date().toISOString(),
    };

    let result;
    if (existing && existing.is_deleted) {
      result = await supabaseAdmin
        .from("customer_coin_promo_codes")
        .update(payload)
        .eq("id", existing.id)
        .select()
        .single();
    } else {
      result = await supabaseAdmin
        .from("customer_coin_promo_codes")
        .insert(payload)
        .select()
        .single();
    }

    if (result.error) {
      logger.error({ error: result.error, code: upperCode }, "Failed to create customer promo code");
      return reply.status(500).send({ error: "Failed to create customer promo code" });
    }

    logger.info({ code: upperCode, coins_amount }, "Admin created customer coin promo code");
    return reply.status(201).send({ promo: result.data });
  });

  /**
   * PATCH /admin/customer-promos/:id — Update customer coin promo code
   */
  app.patch("/admin/customer-promos/:id", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const updatePayload: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (body.is_active !== undefined) updatePayload.is_active = Boolean(body.is_active);
    if (body.coins_amount !== undefined) updatePayload.coins_amount = Number(body.coins_amount);
    if (body.max_redemptions !== undefined) updatePayload.max_redemptions = body.max_redemptions;
    if (body.expires_at !== undefined) updatePayload.expires_at = body.expires_at;
    if (body.description !== undefined) updatePayload.description = body.description?.trim() || null;

    const { data: updated, error } = await supabaseAdmin
      .from("customer_coin_promo_codes")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      logger.error({ error, id }, "Failed to update customer promo code");
      return reply.status(500).send({ error: "Failed to update customer promo code" });
    }

    return reply.send({ promo: updated });
  });

  /**
   * DELETE /admin/customer-promos/:id — Soft-delete customer coin promo code
   */
  app.delete("/admin/customer-promos/:id", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };

    const { data: updated, error } = await supabaseAdmin
      .from("customer_coin_promo_codes")
      .update({
        is_active: false,
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      logger.error({ error, id }, "Failed to delete customer promo code");
      return reply.status(500).send({ error: "Failed to delete customer promo code" });
    }

    logger.info({ id, code: updated?.code }, "Admin deleted customer coin promo code");
    return reply.send({
      success: true,
      message: `Customer promo code "${updated?.code || id}" deleted successfully.`,
      promo: updated,
    });
  });
}
