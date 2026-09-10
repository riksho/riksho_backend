import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { z } from "zod";
import { sendPush } from "../notifications/push.service.js";
import { withSignedUrls } from "../../common/document-urls.js";
import {
  sendBusinessApprovalEmail,
  sendBusinessApprovalSMS,
} from "../notifications/business-notifications.service.js";

const ReasonSchema = z.object({ reason: z.string().min(1).optional() });

export async function adminRoutes(app: FastifyInstance) {
  const guard = { preHandler: [authGuard, requireRole("admin")] };

  app.get("/admin/me", guard, async (req) => ({
    id: req.user!.id, email: req.user!.email, role: "admin",
  }));

  app.get("/admin/stats", guard, async () => {
    const today = new Date(); 
    today.setHours(0,0,0,0);
    const iso = today.toISOString();
    
    const [pending, approved, online, ridesToday] = await Promise.all([
      supabaseAdmin.from("drivers").select("id", { count: "exact", head: true }).eq("verification_status", "pending"),
      supabaseAdmin.from("drivers").select("id", { count: "exact", head: true }).eq("is_verified", true),
      supabaseAdmin.from("drivers").select("id", { count: "exact", head: true }).eq("status", "online"),
      supabaseAdmin.from("rides").select("id", { count: "exact", head: true }).gte("created_at", iso),
    ]);
    
    return {
      pending: pending.count ?? 0, 
      approved: approved.count ?? 0,
      online: online.count ?? 0, 
      rides_today: ridesToday.count ?? 0,
    };
  });

  app.get("/admin/drivers", guard, async (req) => {
    const { status = "pending", q, page = "0" } = req.query as any;
    let query = supabaseAdmin
      .from("drivers")
      .select("id, name, phone, license_no, status, verification_status, is_verified, rating, total_trips, created_at, vehicles!vehicles_driver_id_fkey(type, plate, model)")
      .order("created_at", { ascending: false })
      .range(Number(page) * 20, Number(page) * 20 + 19);
      
    if (status !== "all") query = query.eq("verification_status", status);
    if (q) {
      query = query.or(`phone.ilike.%${q}%,name.ilike.%${q}%`);
    }
    
    const { data, error } = await query;
    if (error) throw error;

    const normalized = (data ?? []).map((driver: any) => {
      const v = driver.vehicles;
      const vehicleList = Array.isArray(v) ? v : v ? [v] : [];
      return {
        ...driver,
        vehicles: vehicleList,
        vehicle: vehicleList[0] || null,
      };
    });

    return normalized;
  });

  app.get("/admin/incomplete-drivers", guard, async () => {
    const { data: drivers, error: driversError } = await supabaseAdmin.from("drivers").select("id");
    if (driversError) throw driversError;
    const driverIds = new Set(drivers.map(d => d.id));

    const { data: usersData, error: usersError } = await supabaseAdmin.auth.admin.listUsers();
    if (usersError) throw usersError;

    const incompleteUsers = usersData.users
      .filter(u => u.phone && !driverIds.has(u.id))
      .map(u => ({
        id: u.id,
        phone: u.phone,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
      }))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return incompleteUsers;
  });

  app.get("/admin/drivers/:id", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { data, error } = await supabaseAdmin
      .from("drivers").select("*, vehicles!vehicles_driver_id_fkey(*), driver_documents(*)").eq("id", id).single();
      
    if (error || !data) return reply.status(404).send({ error: "Driver not found" });

    const rawVehicles = data.vehicles;
    const vehiclesList = Array.isArray(rawVehicles)
      ? rawVehicles
      : rawVehicles
      ? [rawVehicles]
      : [];

    return {
      ...data,
      vehicles: vehiclesList,
      vehicle: vehiclesList[0] || null,
      driver_documents: await withSignedUrls(data.driver_documents),
    };
  });

  const setStatus = async (id: string, verified: boolean, status: string, adminId: string, reason?: string) => {
    const { error: updateError } = await supabaseAdmin.from("drivers")
      .update({ is_verified: verified, verification_status: status })
      .eq("id", id);
      
    if (updateError) {
      logger.error({ id, error: updateError }, "Failed to update driver status");
      throw new Error("Failed to update status");
    }

    // Also update the status of all documents uploaded by this driver
    await supabaseAdmin.from("driver_documents")
      .update({ status: status })
      .eq("driver_id", id);

    const { error: insertError } = await supabaseAdmin.from("admin_actions").insert({
      admin_id: adminId, driver_id: id, action: status, reason: reason ?? null,
    });
    
    if (insertError) {
      logger.error({ id, error: insertError }, "Failed to record admin action (non-fatal for driver state)");
    }
    
    if (status === "approved") {
      await sendPush([id], {
        title: "Profile Approved",
        body: "Your Riksho Buddy account is approved. Go online to start earning!",
        data: { type: "driver_approved", status: "approved" },
      }).catch(err => {
        logger.error({ id, err }, "Failed to send approval push notification");
      });
    }

    logger.info({ id, status, adminId }, "Admin changed driver verification");
  };

  app.post("/admin/drivers/:id/approve", guard, async (req) => {
    const { id } = req.params as { id: string };
    await setStatus(id, true, "approved", req.user!.id);
    return { ok: true, verification_status: "approved" };
  });

  app.post("/admin/drivers/:id/reject", guard, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = ReasonSchema.parse(req.body);
    await setStatus(id, false, "rejected", req.user!.id, reason);
    return { ok: true, verification_status: "rejected" };
  });

  app.post("/admin/drivers/:id/suspend", guard, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = ReasonSchema.parse(req.body);
    await setStatus(id, false, "suspended", req.user!.id, reason);
    return { ok: true, verification_status: "suspended" };
  });

  // ─── Business Management Endpoints ─────────────────────────────────

  // GET /admin/businesses — List all registered businesses with filtering
  app.get("/admin/businesses", guard, async (req) => {
    const { status = "pending", q } = req.query as any;

    let query = supabaseAdmin
      .from("businesses")
      .select("*")
      .order("created_at", { ascending: false });

    if (status && status !== "all") {
      query = query.eq("status", status);
    }

    if (q) {
      query = query.or(`name.ilike.%${q}%,gstin.ilike.%${q}%,pan.ilike.%${q}%,city.ilike.%${q}%,contact_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    }

    const { data: businesses, error } = await query;
    if (error) {
      logger.error({ error }, "Failed to query businesses for admin");
      throw error;
    }

    // Also fetch status counts
    const { data: allBiz } = await supabaseAdmin
      .from("businesses")
      .select("status");

    const counts = {
      pending: (allBiz || []).filter(b => b.status === "pending").length,
      active: (allBiz || []).filter(b => b.status === "active" || b.status === "approved").length,
      rejected: (allBiz || []).filter(b => b.status === "rejected").length,
      all: (allBiz || []).length,
    };

    return {
      businesses: businesses || [],
      counts,
    };
  });

  // POST /admin/businesses/:id/approve — Approve business & dispatch congratulatory Email + SMS
  app.post("/admin/businesses/:id/approve", guard, async (req, reply) => {
    const { id } = req.params as { id: string };

    // 1. Fetch current business details
    const { data: biz, error: fetchErr } = await supabaseAdmin
      .from("businesses")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !biz) {
      return reply.status(404).send({ error: "Business not found" });
    }

    // 2. Update status to active
    const { error: updateErr } = await supabaseAdmin
      .from("businesses")
      .update({ status: "active" })
      .eq("id", id);

    if (updateErr) {
      logger.error({ id, error: updateErr }, "Failed to approve business status");
      throw updateErr;
    }

    // 3. Upgrade owner account type in users table
    if (biz.owner_user_id) {
      try {
        await supabaseAdmin
          .from("users")
          .update({ account_type: "business" })
          .eq("id", biz.owner_user_id);
      } catch (err) {
        logger.warn({ err }, "Could not upgrade users account_type");
      }
    }

    // 4. Record admin action log
    try {
      await supabaseAdmin
        .from("admin_actions")
        .insert({
          admin_id: req.user!.id,
          action: "business_approved",
          reason: `Approved enterprise business ${biz.name} (${biz.gstin || "PAN"})`,
        });
    } catch (err) {
      logger.warn({ err }, "Could not write admin_actions record");
    }

    // 5. Auto-send Congratulatory SMS and Email notifications!
    const notificationPayload = {
      businessId: biz.id,
      businessName: biz.name,
      contactName: biz.contact_name,
      email: biz.email,
      phone: biz.phone,
      city: biz.city,
    };

    const [smsResult, emailResult] = await Promise.allSettled([
      sendBusinessApprovalSMS(notificationPayload),
      sendBusinessApprovalEmail(notificationPayload),
    ]);

    logger.info(
      {
        businessId: id,
        smsStatus: smsResult.status,
        emailStatus: emailResult.status,
      },
      "Dispatched approval notifications to registered business owner"
    );

    return {
      ok: true,
      status: "active",
      notifications: {
        sms: smsResult.status === "fulfilled" ? smsResult.value : { success: false },
        email: emailResult.status === "fulfilled" ? emailResult.value : { success: false },
      },
    };
  });

  // POST /admin/businesses/:id/reject — Reject business registration
  app.post("/admin/businesses/:id/reject", guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = ReasonSchema.parse(req.body || {});

    const { data: biz, error: fetchErr } = await supabaseAdmin
      .from("businesses")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchErr || !biz) {
      return reply.status(404).send({ error: "Business not found" });
    }

    const { error: updateErr } = await supabaseAdmin
      .from("businesses")
      .update({ status: "rejected" })
      .eq("id", id);

    if (updateErr) {
      logger.error({ id, error: updateErr }, "Failed to reject business");
      throw updateErr;
    }

    try {
      await supabaseAdmin
        .from("admin_actions")
        .insert({
          admin_id: req.user!.id,
          action: "business_rejected",
          reason: reason || `Rejected business registration for ${biz.name}`,
        });
    } catch (err) {
      logger.warn({ err }, "Could not write admin_actions record");
    }

    return { ok: true, status: "rejected" };
  });

  app.get("/admin/cancellations", guard, async (req) => {
    const { data, error } = await supabaseAdmin
      .from("rides")
      .select("id, created_at, cancelled_at, cancel_reason, origin_address, dest_address, customer_id, driver_id, vehicle_type, service_type, cancelled_by")
      .eq("status", "cancelled")
      .order("cancelled_at", { ascending: false })
      .limit(100);

    if (error) {
      logger.error({ error }, "Failed to fetch cancellations");
      throw error;
    }
    
    return data ?? [];
  });
}
