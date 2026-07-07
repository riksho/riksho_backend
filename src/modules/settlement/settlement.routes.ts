import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";

/**
 * Settlement / B2B invoicing.
 *
 * Aggregates a business's completed fleet rides in a period into an `invoices`
 * row (business-payable side of the ledger). Fleet API/app shipments settle by
 * invoice (payment_method = 'invoice'), unlike cash rides.
 */

const GenerateInvoiceSchema = z.object({
  business_id: z.string().uuid(),
  period_start: z.string(), // ISO date (YYYY-MM-DD)
  period_end: z.string(),
});

export async function settlementRoutes(app: FastifyInstance) {
  // Resolve the caller's business row (for the self-serve routes).
  async function getBusinessForUser(userId: string) {
    const { data } = await supabaseAdmin
      .from("businesses")
      .select("id")
      .eq("owner_user_id", userId)
      .single();
    return data;
  }

  // Sum completed fleet rides for a business within [start, end].
  async function sumCompletedFleet(businessId: string, start: string, end: string) {
    const { data: rides, error } = await supabaseAdmin
      .from("rides")
      .select("fare_final, fare_estimate, completed_at")
      .eq("business_id", businessId)
      .eq("service_type", "fleet")
      .eq("status", "completed")
      .gte("completed_at", start)
      .lte("completed_at", end);

    if (error) throw error;

    const total = (rides || []).reduce(
      (sum, r) => sum + Number(r.fare_final ?? r.fare_estimate ?? 0),
      0
    );
    return { total, count: rides?.length ?? 0 };
  }

  // POST /admin/invoices/generate — admin generates an invoice for a business+period.
  app.post("/admin/invoices/generate", { preHandler: [authGuard, requireRole("admin")] }, async (request, reply) => {
    const body = GenerateInvoiceSchema.parse(request.body);

    let agg;
    try {
      agg = await sumCompletedFleet(body.business_id, body.period_start, body.period_end);
    } catch (err) {
      logger.error({ err }, "Failed to aggregate fleet rides for invoice");
      return reply.status(500).send({ error: "Failed to aggregate rides" });
    }

    const { data: invoice, error } = await supabaseAdmin
      .from("invoices")
      .insert({
        business_id: body.business_id,
        period_start: body.period_start,
        period_end: body.period_end,
        total_amount: agg.total,
        status: "pending",
      })
      .select()
      .single();

    if (error || !invoice) {
      return reply.status(500).send({ error: "Failed to create invoice" });
    }

    return reply.status(201).send({ invoice, ride_count: agg.count });
  });

  // GET /business/invoices — the caller's own invoices (self-serve portal).
  app.get("/business/invoices", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const business = await getBusinessForUser(request.user!.id);
    if (!business) return reply.status(403).send({ error: "No business account." });

    const { data: invoices, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false });

    if (error) return reply.status(500).send({ error: "Failed to fetch invoices" });
    return reply.send({ invoices: invoices || [] });
  });

  // GET /business/invoices/preview?start=&end= — live unbilled total for the caller.
  app.get("/business/invoices/preview", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const business = await getBusinessForUser(request.user!.id);
    if (!business) return reply.status(403).send({ error: "No business account." });

    const q = request.query as { start?: string; end?: string };
    if (!q.start || !q.end) return reply.status(400).send({ error: "start and end required" });

    try {
      const agg = await sumCompletedFleet(business.id, q.start, q.end);
      return reply.send({ total: agg.total, ride_count: agg.count, period: { start: q.start, end: q.end } });
    } catch {
      return reply.status(500).send({ error: "Failed to compute preview" });
    }
  });
}
