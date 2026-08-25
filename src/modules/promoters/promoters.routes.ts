import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";

const RegisterPromoterSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});

const UpdateBankDetailsSchema = z.object({
  upi_id: z.string().optional().nullable(),
  bank_account_no: z.string().optional().nullable(),
  bank_ifsc: z.string().optional().nullable(),
  bank_name: z.string().optional().nullable(),
  account_holder_name: z.string().optional().nullable(),
});

const LinkDriverSchema = z.object({
  driver_id: z.string().uuid().or(z.string().min(1)),
});

const PayoutRequestSchema = z.object({
  amount: z.number().int().min(1000, "Minimum withdrawal is ₹10 (1000 paise)"),
  payout_method: z.enum(["upi", "bank"]).default("upi"),
  upi_id: z.string().optional(),
  bank_account_no: z.string().optional(),
  bank_ifsc: z.string().optional(),
  bank_name: z.string().optional(),
  account_holder_name: z.string().optional(),
});

const AdminUpdateStatusSchema = z.object({
  status: z.enum(["approved", "rejected", "pending"]),
  rejection_reason: z.string().optional(),
});

const AdminUpdatePayoutSchema = z.object({
  status: z.enum(["approved", "paid", "rejected", "pending"]),
  transaction_ref: z.string().optional(),
  admin_notes: z.string().optional(),
});

export async function promotersRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: [authGuard, requireRole("admin")] };

  /**
   * GET /promoters/me — Get authenticated promoter's profile and approval status
   */
  app.get("/promoters/me", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;

    const { data: promoter, error } = await supabaseAdmin
      .from("promoters")
      .select("*")
      .eq("id", userId)
      .single();

    if (error && error.code !== "PGRST116") {
      logger.error({ error, userId }, "Failed to fetch promoter profile");
      return reply.status(500).send({ error: "Failed to fetch promoter profile" });
    }

    if (!promoter) {
      return reply.send({
        registered: false,
        user: {
          id: userId,
          phone: request.user!.phone,
          email: request.user!.email,
        },
      });
    }

    return reply.send({
      registered: true,
      ...promoter,
    });
  });

  /**
   * POST /promoters/register — Register promoter profile (starts as 'pending')
   */
  app.post("/promoters/register", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = RegisterPromoterSchema.parse(request.body);
    const phone = body.phone || request.user!.phone;

    if (!phone) {
      return reply.status(400).send({ error: "Phone number is required for promoter registration" });
    }

    const { data, error } = await supabaseAdmin
      .from("promoters")
      .upsert(
        {
          id: userId,
          name: body.name,
          phone,
          email: body.email || request.user!.email || null,
          approval_status: "pending",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      )
      .select()
      .single();

    if (error) {
      logger.error({ error, userId }, "Failed to register promoter");
      return reply.status(500).send({ error: "Failed to submit promoter registration" });
    }

    // Set role to 'promoter' or record in users table
    await supabaseAdmin
      .from("users")
      .upsert({
        id: userId,
        phone,
        name: body.name,
        role: "promoter",
        updated_at: new Date().toISOString(),
      })
      .then();

    return reply.status(201).send(data);
  });

  /**
   * PUT /promoters/bank-details — Update payout bank/UPI credentials
   */
  app.put("/promoters/bank-details", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = UpdateBankDetailsSchema.parse(request.body);

    const { data, error } = await supabaseAdmin
      .from("promoters")
      .update({
        upi_id: body.upi_id,
        bank_account_no: body.bank_account_no,
        bank_ifsc: body.bank_ifsc,
        bank_name: body.bank_name,
        account_holder_name: body.account_holder_name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select()
      .single();

    if (error) {
      logger.error({ error, userId }, "Failed to update promoter bank details");
      return reply.status(500).send({ error: "Failed to update banking details" });
    }

    return reply.send(data);
  });

  /**
   * GET /promoters/dashboard — Get earnings metrics, recruits list, and payout history
   */
  app.get("/promoters/dashboard", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;

    // 1. Fetch promoter profile
    const { data: promoter, error: promoterError } = await supabaseAdmin
      .from("promoters")
      .select("*")
      .eq("id", userId)
      .single();

    if (promoterError || !promoter) {
      return reply.status(404).send({ error: "Promoter profile not found" });
    }

    if (promoter.approval_status !== "approved") {
      return reply.status(403).send({
        error: "PROMOTER_NOT_APPROVED",
        approval_status: promoter.approval_status,
        rejection_reason: promoter.rejection_reason,
        message: "Your promoter account is pending admin approval.",
      });
    }

    // 2. Fetch recruits list
    const { data: referrals, error: refError } = await supabaseAdmin
      .from("promoter_referrals")
      .select("*")
      .eq("promoter_id", userId)
      .order("created_at", { ascending: false });

    if (refError) {
      logger.error({ error: refError }, "Failed to fetch referrals");
    }

    // 3. Fetch payout requests history
    const { data: payouts, error: payoutError } = await supabaseAdmin
      .from("promoter_payout_requests")
      .select("*")
      .eq("promoter_id", userId)
      .order("requested_at", { ascending: false });

    if (payoutError) {
      logger.error({ error: payoutError }, "Failed to fetch payout requests");
    }

    return reply.send({
      promoter,
      stats: {
        total_recruits: promoter.total_recruits || 0,
        total_earnings: promoter.total_earnings || 0,
        available_balance: promoter.available_balance || 0,
        withdrawn_amount: promoter.withdrawn_amount || 0,
      },
      referrals: referrals || [],
      payouts: payouts || [],
    });
  });

  /**
   * POST /promoters/link-driver — Scan and link a driver recruit (+₹20 reward)
   * Supports [TEST] mode for testing and scans outside the fresh 2-hour auto-bomb window.
   */
  app.post("/promoters/link-driver", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const { driver_id: rawDriverId } = LinkDriverSchema.parse(request.body);

    // Parse potential QR code prefixes like "riksho-driver:test:<uuid>", "riksho-driver:<uuid>" or URL parameters
    let isTest = false;
    let cleanDriverId = rawDriverId.trim();

    if (cleanDriverId.startsWith("riksho-driver:test:")) {
      isTest = true;
      cleanDriverId = cleanDriverId.replace("riksho-driver:test:", "").trim();
    } else if (cleanDriverId.startsWith("test:")) {
      isTest = true;
      cleanDriverId = cleanDriverId.replace("test:", "").trim();
    } else if (cleanDriverId.startsWith("riksho-driver:")) {
      cleanDriverId = cleanDriverId.replace("riksho-driver:", "").trim();
    } else if (cleanDriverId.includes("driver_id=")) {
      const match = cleanDriverId.match(/driver_id=([a-f0-9-]+)/i);
      if (match) cleanDriverId = match[1];
    }

    // 1. Verify promoter is approved
    const { data: promoter, error: promoterErr } = await supabaseAdmin
      .from("promoters")
      .select("id, approval_status, available_balance, total_earnings, total_recruits")
      .eq("id", userId)
      .single();

    if (promoterErr || !promoter || promoter.approval_status !== "approved") {
      return reply.status(403).send({
        error: "PROMOTER_NOT_APPROVED",
        message: "Only approved promoters can recruit and verify drivers.",
      });
    }

    // 2. Fetch driver profile from drivers and users table
    const { data: driver, error: driverErr } = await supabaseAdmin
      .from("drivers")
      .select("id, created_at, verification_status")
      .eq("id", cleanDriverId)
      .single();

    if (driverErr || !driver) {
      return reply.status(404).send({
        error: "DRIVER_NOT_FOUND",
        message: "No driver found matching this QR code / ID.",
      });
    }

    // Check 2-hour auto-bomb window (if driver was registered >= 2 hours ago, mark as [TEST])
    if (driver.created_at) {
      const driverCreatedTime = new Date(driver.created_at).getTime();
      const elapsedMs = Date.now() - driverCreatedTime;
      const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
      if (elapsedMs >= TWO_HOURS_MS) {
        isTest = true;
      }
    }

    const { data: driverUser } = await supabaseAdmin
      .from("users")
      .select("name, phone")
      .eq("id", cleanDriverId)
      .single();

    const rawDriverName = driverUser?.name || "Riksho Partner";
    const driverName = isTest && !rawDriverName.startsWith("[TEST]")
      ? `[TEST] ${rawDriverName}`
      : rawDriverName;
    const driverPhone = driverUser?.phone || "Registered Driver";

    // 3. Check if driver has already been linked to any promoter
    const { data: existingReferral } = await supabaseAdmin
      .from("promoter_referrals")
      .select("id, promoter_id, created_at")
      .eq("driver_id", cleanDriverId)
      .single();

    if (existingReferral) {
      return reply.status(409).send({
        error: "DRIVER_ALREADY_LINKED",
        message: `This driver has already been recruited and verified previously on ${new Date(existingReferral.created_at).toLocaleDateString()}.`,
      });
    }

    const REWARD_AMOUNT = 2000; // ₹20 in paise

    // 4. Insert referral record
    const { data: referral, error: insertErr } = await supabaseAdmin
      .from("promoter_referrals")
      .insert({
        promoter_id: userId,
        driver_id: cleanDriverId,
        driver_name: driverName,
        driver_phone: driverPhone,
        reward_amount: REWARD_AMOUNT,
        status: "verified",
      })
      .select()
      .single();

    if (insertErr) {
      logger.error({ insertErr }, "Failed to insert referral");
      return reply.status(500).send({ error: "Failed to record referral" });
    }

    // 5. Update promoter balance and totals
    const newTotalEarnings = (promoter.total_earnings || 0) + REWARD_AMOUNT;
    const newAvailableBalance = (promoter.available_balance || 0) + REWARD_AMOUNT;
    const newTotalRecruits = (promoter.total_recruits || 0) + 1;

    await supabaseAdmin
      .from("promoters")
      .update({
        total_earnings: newTotalEarnings,
        available_balance: newAvailableBalance,
        total_recruits: newTotalRecruits,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    return reply.status(201).send({
      success: true,
      is_test: isTest,
      message: isTest
        ? `Driver ${driverName} verified in Testing Mode! ₹20 added to balance.`
        : `Driver ${driverName} successfully verified! ₹20 added to your balance.`,
      referral,
      new_balance: newAvailableBalance,
    });
  });

  /**
   * POST /promoters/payout-request — Submit a withdrawal request
   */
  app.post("/promoters/payout-request", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const body = PayoutRequestSchema.parse(request.body);

    // 1. Check promoter profile and available balance
    const { data: promoter, error: promoterErr } = await supabaseAdmin
      .from("promoters")
      .select("*")
      .eq("id", userId)
      .single();

    if (promoterErr || !promoter || promoter.approval_status !== "approved") {
      return reply.status(403).send({ error: "Promoter not approved or found" });
    }

    if (promoter.available_balance < body.amount) {
      return reply.status(400).send({
        error: "INSUFFICIENT_BALANCE",
        message: `Requested ₹${(body.amount / 100).toFixed(2)}, but available balance is only ₹${(promoter.available_balance / 100).toFixed(2)}.`,
      });
    }

    const upiId = body.upi_id || promoter.upi_id;
    const bankAccountNo = body.bank_account_no || promoter.bank_account_no;
    const bankIfsc = body.bank_ifsc || promoter.bank_ifsc;
    const bankName = body.bank_name || promoter.bank_name;
    const accountHolderName = body.account_holder_name || promoter.account_holder_name || promoter.name;

    if (body.payout_method === "upi" && !upiId) {
      return reply.status(400).send({ error: "UPI ID is required for UPI payout" });
    }
    if (body.payout_method === "bank" && (!bankAccountNo || !bankIfsc)) {
      return reply.status(400).send({ error: "Bank account number and IFSC are required for bank payout" });
    }

    // 2. Deduct from available balance & mark as withdrawn in progress
    const newAvailableBalance = promoter.available_balance - body.amount;
    const newWithdrawn = (promoter.withdrawn_amount || 0) + body.amount;

    await supabaseAdmin
      .from("promoters")
      .update({
        available_balance: newAvailableBalance,
        withdrawn_amount: newWithdrawn,
        ...(upiId && { upi_id: upiId }),
        ...(bankAccountNo && { bank_account_no: bankAccountNo, bank_ifsc: bankIfsc, bank_name: bankName, account_holder_name: accountHolderName }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    // 3. Create payout request record
    const { data: payoutRequest, error: payoutErr } = await supabaseAdmin
      .from("promoter_payout_requests")
      .insert({
        promoter_id: userId,
        amount: body.amount,
        payout_method: body.payout_method,
        upi_id: upiId || null,
        bank_account_no: bankAccountNo || null,
        bank_ifsc: bankIfsc || null,
        bank_name: bankName || null,
        account_holder_name: accountHolderName || null,
        status: "pending",
      })
      .select()
      .single();

    if (payoutErr) {
      logger.error({ payoutErr }, "Failed to create payout request");
      return reply.status(500).send({ error: "Failed to submit payout request" });
    }

    return reply.status(201).send({
      success: true,
      message: "Payout request submitted successfully. Admin will process your payment soon.",
      payout: payoutRequest,
      remaining_balance: newAvailableBalance,
    });
  });

  // ==========================================
  // ADMIN ROUTES (Admin role required)
  // ==========================================

  /**
   * GET /admin/promoters — List all promoters with filter
   */
  app.get("/admin/promoters", adminGuard, async (request, reply) => {
    const { status } = request.query as any;

    let query = supabaseAdmin
      .from("promoters")
      .select("*")
      .order("created_at", { ascending: false });

    if (status && ["pending", "approved", "rejected"].includes(status)) {
      query = query.eq("approval_status", status);
    }

    const { data, error } = await query;

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch promoters" });
    }

    return reply.send({ promoters: data || [] });
  });

  /**
   * PUT /admin/promoters/:id/status — Approve or reject promoter
   */
  app.put("/admin/promoters/:id/status", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, rejection_reason } = AdminUpdateStatusSchema.parse(request.body);

    const { data, error } = await supabaseAdmin
      .from("promoters")
      .update({
        approval_status: status,
        rejection_reason: status === "rejected" ? rejection_reason || "Application rejected by admin" : null,
        approved_at: status === "approved" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to update promoter status" });
    }

    return reply.send({ success: true, promoter: data });
  });

  /**
   * GET /admin/promoters/payouts — List all payout requests
   */
  app.get("/admin/promoters/payouts", adminGuard, async (request, reply) => {
    const { status } = request.query as any;

    let query = supabaseAdmin
      .from("promoter_payout_requests")
      .select("*, promoters(name, phone, email)")
      .order("requested_at", { ascending: false });

    if (status && ["pending", "approved", "paid", "rejected"].includes(status)) {
      query = query.eq("status", status);
    }

    const { data, error } = await query;

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch payout requests" });
    }

    return reply.send({ payouts: data || [] });
  });

  /**
   * PUT /admin/promoters/payouts/:id/status — Update payout status (Paid / Rejected / Approved)
   */
  app.put("/admin/promoters/payouts/:id/status", adminGuard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, transaction_ref, admin_notes } = AdminUpdatePayoutSchema.parse(request.body);

    // Fetch existing payout request
    const { data: existingPayout, error: getErr } = await supabaseAdmin
      .from("promoter_payout_requests")
      .select("*")
      .eq("id", id)
      .single();

    if (getErr || !existingPayout) {
      return reply.status(404).send({ error: "Payout request not found" });
    }

    // If rejecting a previously pending payout, refund the amount to promoter's available balance
    if (status === "rejected" && existingPayout.status !== "rejected") {
      const { data: promoter } = await supabaseAdmin
        .from("promoters")
        .select("available_balance, withdrawn_amount")
        .eq("id", existingPayout.promoter_id)
        .single();

      if (promoter) {
        await supabaseAdmin
          .from("promoters")
          .update({
            available_balance: promoter.available_balance + existingPayout.amount,
            withdrawn_amount: Math.max(0, (promoter.withdrawn_amount || 0) - existingPayout.amount),
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingPayout.promoter_id);
      }
    }

    const { data: updatedPayout, error: updateErr } = await supabaseAdmin
      .from("promoter_payout_requests")
      .update({
        status,
        transaction_ref: transaction_ref || existingPayout.transaction_ref,
        admin_notes: admin_notes || existingPayout.admin_notes,
        processed_at: (status === "paid" || status === "rejected") ? new Date().toISOString() : null,
      })
      .eq("id", id)
      .select()
      .single();

    if (updateErr) {
      return reply.status(500).send({ error: "Failed to update payout request" });
    }

    return reply.send({ success: true, payout: updatedPayout });
  });
}
