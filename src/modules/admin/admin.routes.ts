import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { z } from "zod";
import { sendPush } from "../notifications/push.service.js";
import { withSignedUrls } from "../../common/document-urls.js";

const ReasonSchema = z.object({ reason: z.string().min(1) });

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
    return data ?? [];
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

    return { ...data, driver_documents: await withSignedUrls(data.driver_documents) };
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
        title: "Profile Approved \u2705",
        body: "Congratulations! Your driver profile has been verified. You can now go online and accept rides."
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
}
