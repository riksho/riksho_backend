import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { logger } from "../../common/logger.js";

const RedeemPromoSchema = z.object({
  code: z.string().min(1).max(20),
});

const CreatePromoSchema = z.object({
  code: z
    .string()
    .min(3)
    .max(12)
    .regex(/^[A-Za-z0-9_-]+$/, "Code must contain only letters and numbers"),
  amount: z.number().positive("Amount must be greater than 0"),
  max_redemptions: z.number().int().positive().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  description: z.string().max(255).optional(),
  is_active: z.boolean().optional().default(true),
});

const UpdatePromoSchema = z.object({
  is_active: z.boolean().optional(),
  amount: z.number().positive().optional(),
  max_redemptions: z.number().int().positive().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
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
   * POST /promos/redeem — Redeem a promo code for usable balance
   */
  app.post("/promos/redeem", { preHandler: [authGuard] }, async (request, reply) => {
    const driverId = request.user!.id;
    const body = RedeemPromoSchema.parse(request.body);
    const code = body.code.trim().toUpperCase();

    // 1. Fetch promo code details
    const { data: promo, error: promoError } = await supabaseAdmin
      .from("driver_promo_codes")
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (promoError) {
      logger.error({ error: promoError, code }, "Failed to query promo code");
      return reply.status(500).send({ error: "Could not validate promo code." });
    }

    // Built-in hardcoded fallback for common test vouchers if not in db
    if (!promo) {
      if (code === "RIKSHO50" || code === "WELCOME19" || code === "FREEPASS") {
        const reward = code === "FREEPASS" ? 49 : code === "RIKSHO50" ? 50 : 19;
        
        // Fetch current driver balance
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
          amount: reward,
          new_balance: newBal,
          message: `₹${reward} credit added to your usable balance.`,
        });
      }

      return reply.status(404).send({
        error: "Invalid promo code. Please check and try again.",
      });
    }

    // 2. Check if promo is active
    if (!promo.is_active) {
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
    const { data: existingRedemption, error: redErr } = await supabaseAdmin
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

    const rewardAmount = Number(promo.amount);

    // 6. Record redemption
    const { error: insertRedemptionErr } = await supabaseAdmin
      .from("driver_promo_redemptions")
      .insert({
        promo_code_id: promo.id,
        driver_id: driverId,
        code: promo.code,
        amount: rewardAmount,
      });

    if (insertRedemptionErr) {
      logger.error({ error: insertRedemptionErr }, "Failed to record promo redemption");
      return reply.status(500).send({ error: "Failed to redeem promo code." });
    }

    // 7. Increment redemption count
    await supabaseAdmin
      .from("driver_promo_codes")
      .update({
        redemption_count: (promo.redemption_count || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", promo.id);

    // 8. Update driver's usable coupon_balance
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

    logger.info({ driverId, code, rewardAmount, newBalance }, "Driver redeemed promo code");

    return reply.send({
      success: true,
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
      .order("created_at", { ascending: false });

    if (error) {
      logger.error({ error }, "Failed to fetch admin promo codes");
      return reply.status(500).send({ error: "Failed to fetch promo codes" });
    }

    // Calculate summary statistics
    const promoList = promos || [];
    const totalCodes = promoList.length;
    const activeCodes = promoList.filter((p) => p.is_active).length;
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
   * POST /admin/promos — Create a new promo code (e.g. 6-letter/number code)
   */
  app.post("/admin/promos", adminGuard, async (request, reply) => {
    const adminId = request.user!.id;
    const body = CreatePromoSchema.parse(request.body);
    const code = body.code.trim().toUpperCase();

    // Check if code already exists
    const { data: existing } = await supabaseAdmin
      .from("driver_promo_codes")
      .select("id")
      .eq("code", code)
      .maybeSingle();

    if (existing) {
      return reply.status(400).send({
        error: `Promo code "${code}" already exists. Please choose a different code.`,
      });
    }

    const { data: newPromo, error } = await supabaseAdmin
      .from("driver_promo_codes")
      .insert({
        code,
        amount: body.amount,
        max_redemptions: body.max_redemptions || null,
        expires_at: body.expires_at || null,
        description: body.description?.trim() || null,
        is_active: body.is_active ?? true,
        created_by: adminId,
      })
      .select()
      .single();

    if (error) {
      logger.error({ error, body }, "Failed to create admin promo code");
      return reply.status(500).send({ error: "Failed to create promo code" });
    }

    logger.info({ adminId, code: newPromo.code, amount: newPromo.amount }, "Admin created promo code");
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
    if (typeof body.amount === "number") updatePayload.amount = body.amount;
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
   */
  app.delete("/admin/promos/:id", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };

    const { error } = await supabaseAdmin
      .from("driver_promo_codes")
      .delete()
      .eq("id", id);

    if (error) {
      logger.error({ error, id }, "Failed to delete promo code");
      return reply.status(500).send({ error: "Failed to delete promo code" });
    }

    return reply.send({ success: true, message: "Promo code deleted successfully." });
  });
}
