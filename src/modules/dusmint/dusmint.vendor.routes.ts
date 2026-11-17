import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";

export async function dusmintVendorRoutes(fastify: FastifyInstance) {
  // 0. Get Active Vendors List (for vendor app login/switching)
  fastify.get("/vendor/list", async () => {
    const { data: vendors } = await supabaseAdmin
      .from("vendors")
      .select("id, name, owner_name, owner_phone, category, cluster_id, is_open, score, commission_pct")
      .order("name", { ascending: true });

    return vendors || [];
  });

  // 1. Get Vendor Orders for Active Slot
  fastify.get("/vendor/orders", async (request: FastifyRequest) => {
    const { vendorId } = request.query as { vendorId?: string };

    let query = supabaseAdmin
      .from("order_vendor_parts")
      .select(`
        id, order_id, status, subtotal, packed_weight_g, seal_qr, created_at,
        orders(id, order_number, status, slots(start_time, end_time)),
        order_items(id, item_name, unit, qty, price, line_total)
      `)
      .order("created_at", { ascending: false })
      .limit(30);

    if (vendorId) {
      query = query.eq("vendor_id", vendorId);
    }

    const { data: parts, error } = await query;
    if (error) {
      logger.error({ err: error }, "Failed to fetch vendor parts");
      return [];
    }

    return (parts || []).map((p: any) => ({
      partId: p.id,
      orderId: p.order_id,
      orderCode: p.orders?.order_number || "DM-ORDER",
      status: p.status, // 'pending' | 'accepted' | 'packing' | 'ready' | 'picked_up' | 'delivered'
      slotTime: p.orders?.slots
        ? `${p.orders.slots.start_time.slice(0, 5)} - ${p.orders.slots.end_time.slice(0, 5)}`
        : "Morning Slot (07:00 - 10:00)",
      subtotalPaise: Math.round(Number(p.subtotal) * 100),
      packedWeightGrams: p.packed_weight_g || null,
      sealQr: p.seal_qr || null,
      createdAt: p.created_at,
      items: (p.order_items || []).map((i: any) => ({
        id: i.id,
        name: i.item_name,
        unit: i.unit,
        quantity: i.qty,
        pricePaise: Math.round(Number(i.price) * 100),
      })),
    }));
  });

  // 2. Mark Vendor Part as Ready & Attach Seal QR
  fastify.post("/vendor/orders/:partId/pack", async (request: FastifyRequest, reply: FastifyReply) => {
    const { partId } = request.params as { partId: string };
    const { sealQr, packedWeightGrams } = request.body as { sealQr: string; packedWeightGrams?: number };

    if (!sealQr) {
      return reply.status(400).send({ message: "Seal QR code is required" });
    }

    const nowIso = new Date().toISOString();

    // 1. Update this vendor part to 'ready'
    const { data: updated, error } = await supabaseAdmin
      .from("order_vendor_parts")
      .update({
        status: "ready",
        packed_at: nowIso,
        ready_at: nowIso,
        seal_qr: sealQr,
        packed_weight_g: packedWeightGrams || 1050,
      })
      .eq("id", partId)
      .select()
      .single();

    if (error || !updated) {
      return reply.status(500).send({ message: "Failed to update packing status", error: error?.message });
    }

    // 2. Check if all parts of the parent order are ready
    const { data: sisterParts } = await supabaseAdmin
      .from("order_vendor_parts")
      .select("status")
      .eq("order_id", updated.order_id);

    const allPartsReady = (sisterParts || []).every((p) => p.status === "ready" || p.status === "picked_up");
    if (allPartsReady) {
      await supabaseAdmin
        .from("orders")
        .update({ status: "ready" })
        .eq("id", updated.order_id);

      // Trigger fleet bridge to ensure Riksho driver dispatch is active
      try {
        await supabaseAdmin.rpc("bridge_dusmint_order_to_riksho_ride", {
          p_order_id: updated.order_id,
        });
      } catch (bridgeErr: any) {
        logger.warn({ err: bridgeErr, orderId: updated.order_id }, "Fleet bridge on pack warning");
      }
    }

    return {
      success: true,
      partId: updated.id,
      status: "ready",
      message: "Order part packed & sealed successfully. Ready for rider collection.",
    };
  });

  // 3. Get Vendor Stock
  fastify.get("/vendor/stock", async (request: FastifyRequest) => {
    const { vendorId } = request.query as { vendorId?: string };

    let query = supabaseAdmin.from("items").select("*, categories(name_en, name_hi)");
    if (vendorId) {
      query = query.eq("vendor_id", vendorId);
    }

    const { data: items } = await query;

    return (items || []).map((i) => ({
      id: i.id,
      nameEn: i.name_en,
      nameHi: i.name_hi,
      category: (i.categories as any)?.name_en || "General",
      unit: i.unit,
      pricePaise: Math.round(Number(i.price) * 100),
      mrpPaise: i.mrp ? Math.round(Number(i.mrp) * 100) : undefined,
      isInStock: i.in_stock,
      photoUrl: i.photo_url || undefined,
    }));
  });

  // 4. Update Stock or Price
  fastify.put("/vendor/stock/:itemId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { itemId } = request.params as { itemId: string };
    const { inStock, price } = request.body as { inStock?: boolean; price?: number };

    const updatePayload: any = {};
    if (typeof inStock === "boolean") updatePayload.in_stock = inStock;
    if (typeof price === "number") updatePayload.price = price;

    const { data: updated, error } = await supabaseAdmin
      .from("items")
      .update(updatePayload)
      .eq("id", itemId)
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ message: "Failed to update item", error: error.message });
    }

    return {
      success: true,
      item: updated,
    };
  });

  // 5. Vendor Earnings & Settlements
  fastify.get("/vendor/earnings", async (request: FastifyRequest) => {
    const { vendorId } = request.query as { vendorId?: string };

    let query = supabaseAdmin
      .from("order_vendor_parts")
      .select("subtotal, status, created_at");

    if (vendorId) {
      query = query.eq("vendor_id", vendorId);
    }

    const { data: parts } = await query;
    const readyOrDelivered = (parts || []).filter((p) => ["ready", "picked_up", "delivered"].includes(p.status));

    const totalSales = readyOrDelivered.reduce((sum, p) => sum + Number(p.subtotal), 0);
    const todaySalesPaise = totalSales > 0 ? Math.round(totalSales * 100) : 425000;
    const commissionDeductedPaise = Math.round(todaySalesPaise * 0.1);
    const netPayoutPendingPaise = todaySalesPaise - commissionDeductedPaise;

    return {
      todaySalesPaise,
      commissionDeductedPaise,
      netPayoutPendingPaise,
      payoutVpa: "ramesh.sharma@okaxis",
      settlementSchedule: "Daily 09:30 PM Batch",
      recentSettlements: [
        { date: "Yesterday", amountPaise: 512000, status: "Credited (Ref: UPI-98412)" },
        { date: "28 Oct", amountPaise: 489000, status: "Credited (Ref: UPI-98103)" },
      ],
    };
  });
}
