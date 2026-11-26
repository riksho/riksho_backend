import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";

export async function dusmintVendorRoutes(fastify: FastifyInstance) {
  // 0.5 Vendor Onboarding (4 Checklist Items: Owner, Shop & Address, Photo, UPI)
  fastify.post("/vendor/onboarding", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      ownerName: string;
      ownerPhone: string;
      email?: string;
      shopName: string;
      category?: string;
      address: string;
      lat?: number;
      lng?: number;
      shopPhotoUrls?: string[];
      bankOrUpi: string;
      authUserId?: string;
    };

    if (!body.ownerName || !body.ownerPhone || !body.shopName || !body.address || !body.bankOrUpi) {
      return reply.status(400).send({
        success: false,
        message: "Missing required onboarding fields: ownerName, ownerPhone, shopName, address, and bankOrUpi are required.",
      });
    }

    const cleanPhone = body.ownerPhone.replace(/\D/g, "").slice(-10);
    const formattedPhone = `+91${cleanPhone}`;

    // Get or create default cluster
    let { data: cluster } = await supabaseAdmin.from("clusters").select("id").limit(1).maybeSingle();
    if (!cluster) {
      const { data: newCluster } = await supabaseAdmin
        .from("clusters")
        .insert({
          name: "Central Mandi Cluster",
          city: "Patna",
          centre_lat: body.lat || 25.5941,
          centre_lng: body.lng || 85.1376,
          centre: `SRID=4326;POINT(${body.lng || 85.1376} ${body.lat || 25.5941})`,
          radius_m: 15000,
          status: "active",
        })
        .select("id")
        .single();
      cluster = newCluster;
    }

    const validCategories = [
      "vegetables", "fruits", "dairy", "groceries", "bakery", "meat_poultry", "seafood", "household"
    ];
    const category = validCategories.includes(body.category || "") ? body.category : "groceries";

    // Upsert vendor record
    const { data: existingVendor } = await supabaseAdmin
      .from("vendors")
      .select("id")
      .or(`owner_phone.ilike.%${cleanPhone}%${body.authUserId ? `,auth_user_id.eq.${body.authUserId}` : ""}`)
      .maybeSingle();

    const vendorPayload: any = {
      name: body.shopName,
      owner_name: body.ownerName,
      owner_phone: formattedPhone,
      category,
      cluster_id: cluster?.id,
      address: body.address,
      location: `SRID=4326;POINT(${body.lng || 85.1376} ${body.lat || 25.5941})`,
      lat: body.lat || 25.5941,
      lng: body.lng || 85.1376,
      bank_or_upi: body.bankOrUpi,
      payout_mode: "upi",
      status: "verified",
      is_open: true,
      shop_photo_urls: body.shopPhotoUrls || [],
    };

    if (body.authUserId) {
      vendorPayload.auth_user_id = body.authUserId;
    }

    let savedVendor: any = null;
    if (existingVendor) {
      const { data, error } = await supabaseAdmin
        .from("vendors")
        .update(vendorPayload)
        .eq("id", existingVendor.id)
        .select()
        .single();
      if (error) {
        logger.error({ err: error }, "Failed to update vendor onboarding");
        return reply.status(500).send({ success: false, message: error.message });
      }
      savedVendor = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from("vendors")
        .insert(vendorPayload)
        .select()
        .single();
      if (error) {
        logger.error({ err: error }, "Failed to insert vendor onboarding");
        return reply.status(500).send({ success: false, message: error.message });
      }
      savedVendor = data;
    }

    // Persist vendor address in addresses table for geographic search & admin display
    if (body.address) {
      try {
        await supabaseAdmin.from("addresses").insert({
          user_id: body.authUserId || null,
          cluster_id: cluster?.id || null,
          label: "Shop",
          house: body.shopName,
          landmark: body.address,
          location: `SRID=4326;POINT(${body.lng || 85.1376} ${body.lat || 25.5941})`,
          lat: body.lat || 25.5941,
          lng: body.lng || 85.1376,
          is_default: true,
        });
      } catch (addrErr) {
        logger.warn({ err: addrErr }, "Could not record vendor address into addresses table");
      }
    }

    return {
      success: true,
      message: "Vendor onboarded successfully! Welcome to DusMint.",
      vendor: savedVendor,
    };
  });

  // 0. Get Active Vendors List (for vendor app login/switching)
  fastify.get("/vendor/list", async () => {
    const { data: vendors } = await supabaseAdmin
      .from("vendors")
      .select(`
        id, auth_user_id, name, owner_name, owner_phone, category, cluster_id, is_open, score, commission_pct,
        bank_or_upi, address, lat, lng, shop_photo_urls, status,
        clusters(name, city)
      `)
      .order("created_at", { ascending: false });

    return (vendors || []).map((v: any) => ({
      ...v,
      cluster_name: v.clusters?.name || "",
      cluster_city: v.clusters?.city || "",
    }));
  });

  // 0.05 Get Current Active Vendor (matched by phone)
  fastify.get("/vendor/me", async (request: FastifyRequest) => {
    const { phone } = request.query as { phone?: string };
    const cleanPhone = phone ? phone.replace(/\D/g, "").slice(-10) : "";

    let vendor: any = null;

    if (cleanPhone) {
      const { data } = await supabaseAdmin
        .from("vendors")
        .select(`
          id, auth_user_id, name, owner_name, owner_phone, category, cluster_id, is_open, score, commission_pct,
          bank_or_upi, address, lat, lng, shop_photo_urls, status,
          clusters(name, city)
        `)
        .ilike("owner_phone", `%${cleanPhone}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (data) vendor = data;
    }

    if (!vendor) return null;

    return {
      ...vendor,
      cluster_name: vendor.clusters?.name || "",
      cluster_city: vendor.clusters?.city || "",
    };
  });

  // 0.1 Toggle Vendor Live Store Online/Offline Status
  fastify.patch("/vendor/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const { vendorId, isOpen } = request.body as { vendorId: string; isOpen: boolean };

    if (!vendorId) {
      return reply.status(400).send({ success: false, message: "vendorId is required" });
    }

    const { data, error } = await supabaseAdmin
      .from("vendors")
      .update({ is_open: isOpen })
      .eq("id", vendorId)
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ success: false, message: error.message });
    }

    return { success: true, vendor: data };
  });

  // 0.2 Update Vendor Profile Details
  fastify.patch("/vendor/profile", async (request: FastifyRequest, reply: FastifyReply) => {
    const { vendorId, shopName, ownerName, bankOrUpi, category, address } = request.body as {
      vendorId: string;
      shopName?: string;
      ownerName?: string;
      bankOrUpi?: string;
      category?: string;
      address?: string;
    };

    if (!vendorId) {
      return reply.status(400).send({ success: false, message: "vendorId is required" });
    }

    const updates: Record<string, any> = {};
    if (shopName) updates.name = shopName;
    if (ownerName) updates.owner_name = ownerName;
    if (bankOrUpi) updates.bank_or_upi = bankOrUpi;
    if (category) updates.category = category;
    if (address) updates.address = address;

    const { data, error } = await supabaseAdmin
      .from("vendors")
      .update(updates)
      .eq("id", vendorId)
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ success: false, message: error.message });
    }

    return { success: true, vendor: data };
  });

  // 1. Get Vendor Orders for Active Slot
  fastify.get("/vendor/orders", async (request: FastifyRequest) => {
    const { vendorId } = request.query as { vendorId?: string };

    if (!vendorId) {
      return [];
    }

    const query = supabaseAdmin
      .from("order_vendor_parts")
      .select(`
        id, order_id, status, subtotal, packed_weight_g, seal_qr, created_at,
        orders(id, order_number, status, slots(start_time, end_time)),
        order_items(id, item_name, unit, qty, price, line_total)
      `)
      .eq("vendor_id", vendorId)
      .order("created_at", { ascending: false })
      .limit(30);

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

    if (!vendorId) {
      return [];
    }

    const query = supabaseAdmin
      .from("items")
      .select("*, categories(name_en, name_hi)")
      .eq("vendor_id", vendorId);

    const { data: items } = await query;

    return (items || []).map((i: any) => ({
      id: i.id,
      nameEn: i.name_en,
      nameHi: i.name_hi,
      category: i.categories?.name_en || "General",
      unit: i.unit,
      pricePaise: Math.round(Number(i.price) * 100),
      mrpPaise: i.mrp ? Math.round(Number(i.mrp) * 100) : undefined,
      isInStock: i.in_stock,
      photoUrl: i.photo_url || undefined,
      stockKg: i.stock_kg ?? (i.in_stock ? 10 : 0),
      stockGrams: i.stock_grams ?? 0,
    }));
  });

  // 3.5 Add New Item to Vendor Stock
  fastify.post("/vendor/stock", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      vendorId: string;
      nameEn: string;
      nameHi?: string;
      category?: string;
      unit: string;
      pricePaise: number;
      mrpPaise?: number;
      photoUrl?: string;
      isInStock?: boolean;
      stockKg?: number;
      stockGrams?: number;
    };

    if (!body.vendorId || !body.nameEn) {
      return reply.status(400).send({ success: false, message: "vendorId and nameEn are required" });
    }

    // Resolve category_id if matching category exists
    let categoryId: string | null = null;
    if (body.category) {
      const { data: cat } = await supabaseAdmin
        .from("categories")
        .select("id")
        .ilike("name_en", `%${body.category}%`)
        .limit(1)
        .maybeSingle();
      if (cat?.id) categoryId = cat.id;
    }

    const insertPayload: any = {
      vendor_id: body.vendorId,
      category_id: categoryId,
      name_en: body.nameEn,
      name_hi: body.nameHi || body.nameEn,
      unit: body.unit || "1 kg",
      price: Number(((body.pricePaise || 0) / 100).toFixed(2)),
      mrp: body.mrpPaise ? Number((body.mrpPaise / 100).toFixed(2)) : null,
      in_stock: body.isInStock ?? true,
      photo_url: body.photoUrl || null,
    };

    const { data: inserted, error } = await supabaseAdmin
      .from("items")
      .insert(insertPayload)
      .select("*, categories(name_en, name_hi)")
      .single();

    if (error || !inserted) {
      return reply.status(500).send({ success: false, message: error?.message || "Failed to add stock item" });
    }

    return {
      success: true,
      item: {
        id: inserted.id,
        nameEn: inserted.name_en,
        nameHi: inserted.name_hi,
        category: (inserted.categories as any)?.name_en || body.category || "General",
        unit: inserted.unit,
        pricePaise: Math.round(Number(inserted.price) * 100),
        mrpPaise: inserted.mrp ? Math.round(Number(inserted.mrp) * 100) : undefined,
        isInStock: inserted.in_stock,
        photoUrl: inserted.photo_url || undefined,
        stockKg: body.stockKg ?? 10,
        stockGrams: body.stockGrams ?? 0,
      },
    };
  });

  // 4. Update Stock or Price
  fastify.put("/vendor/stock/:itemId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { itemId } = request.params as { itemId: string };
    const { inStock, price, stockKg, stockGrams } = request.body as {
      inStock?: boolean;
      price?: number;
      stockKg?: number;
      stockGrams?: number;
    };

    const updatePayload: any = {};
    if (typeof inStock === "boolean") updatePayload.in_stock = inStock;
    if (typeof price === "number") updatePayload.price = price;
    if (typeof stockKg === "number") updatePayload.stock_kg = stockKg;
    if (typeof stockGrams === "number") updatePayload.stock_grams = stockGrams;

    let { data: updated, error } = await supabaseAdmin
      .from("items")
      .update(updatePayload)
      .eq("id", itemId)
      .select()
      .single();

    // Fallback if stock_kg/stock_grams columns aren't in items table yet
    if (error && (updatePayload.stock_kg !== undefined || updatePayload.stock_grams !== undefined)) {
      delete updatePayload.stock_kg;
      delete updatePayload.stock_grams;
      const retry = await supabaseAdmin
        .from("items")
        .update(updatePayload)
        .eq("id", itemId)
        .select()
        .single();
      updated = retry.data;
      error = retry.error;
    }

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

    if (!vendorId) {
      return {
        todaySalesPaise: 0,
        commissionDeductedPaise: 0,
        netPayoutPendingPaise: 0,
        payoutVpa: "Not configured",
        settlementSchedule: "Daily 09:30 PM Batch",
        recentSettlements: [],
      };
    }

    const query = supabaseAdmin
      .from("order_vendor_parts")
      .select("subtotal, status, created_at")
      .eq("vendor_id", vendorId);

    const { data: parts } = await query;
    const readyOrDelivered = (parts || []).filter((p) => ["ready", "picked_up", "delivered"].includes(p.status));

    const totalSales = readyOrDelivered.reduce((sum, p) => sum + Number(p.subtotal), 0);
    const todaySalesPaise = Math.round(totalSales * 100);
    const commissionDeductedPaise = Math.round(todaySalesPaise * 0.1);
    const netPayoutPendingPaise = todaySalesPaise - commissionDeductedPaise;

    let payoutVpa = "";
    if (vendorId) {
      const { data: v } = await supabaseAdmin
        .from("vendors")
        .select("bank_or_upi")
        .eq("id", vendorId)
        .maybeSingle();
      if (v?.bank_or_upi) payoutVpa = v.bank_or_upi;
    }

    let recentSettlements: any[] = [];
    if (vendorId) {
      const { data: payouts } = await supabaseAdmin
        .from("vendor_payouts")
        .select("id, amount, status, created_at, reference_id")
        .eq("vendor_id", vendorId)
        .order("created_at", { ascending: false })
        .limit(5);

      recentSettlements = (payouts || []).map((p: any) => ({
        date: new Date(p.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
        amountPaise: Math.round(Number(p.amount) * 100),
        status: `${p.status || "Credited"}${p.reference_id ? ` (Ref: ${p.reference_id})` : ""}`.trim(),
      }));
    }

    return {
      todaySalesPaise,
      commissionDeductedPaise,
      netPayoutPendingPaise,
      payoutVpa: payoutVpa || "Not configured",
      settlementSchedule: "Daily 09:30 PM Batch",
      recentSettlements,
    };
  });
}
