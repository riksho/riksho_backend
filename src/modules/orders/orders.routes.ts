import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { logger } from "../../common/logger.js";
import { releaseInventory, releaseInventoryItems } from "../inventory/inventory.service.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { broadcastOrderStatus } from "../matching/broadcast.service.js";
import { QUICK_DELIVERY_FEE } from "../fares/fares.config.js";

const CreateOrderSchema = z.object({
  darkstore_id: z.string().uuid(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    qty: z.number().min(1),
    unit_price: z.number().min(0)
  })).min(1),
  delivery_address: z.string().min(1),
  delivery_lat: z.number(),
  delivery_lng: z.number(),
});

export async function ordersRoutes(app: FastifyInstance) {
  // POST /orders - Place a new Q-Commerce order
  app.post("/orders", { preHandler: [authGuard] }, async (request, reply) => {
    const customerId = request.user!.id;
    const body = CreateOrderSchema.parse(request.body);

    // 1. Calculate totals
    const itemTotal = body.items.reduce((sum, item) => sum + (item.qty * item.unit_price), 0);
    const deliveryFee = QUICK_DELIVERY_FEE;
    const total = itemTotal + deliveryFee;
    const reserveItems = body.items.map((i) => ({ product_id: i.product_id, qty: i.qty }));

    // 2. Reserve Inventory (Atomic RPC)
    const { data: reserveSuccess, error: reserveErr } = await supabaseAdmin.rpc("reserve_inventory", {
      p_darkstore_id: body.darkstore_id,
      p_items: reserveItems,
    });

    if (reserveErr || !reserveSuccess) {
      return reply.status(400).send({
        error: "INSUFFICIENT_INVENTORY",
        message: "One or more items in your cart are out of stock.",
      });
    }

    // 3. Create Order — roll the reservation back if this fails.
    const { data: order, error: orderErr } = await supabaseAdmin
      .from("quick_orders")
      .insert({
        customer_id: customerId,
        darkstore_id: body.darkstore_id,
        item_total: itemTotal,
        delivery_fee: deliveryFee,
        total: total,
        delivery_address: body.delivery_address,
        delivery_lat: body.delivery_lat,
        delivery_lng: body.delivery_lng,
        status: "placed"
      })
      .select()
      .single();

    if (orderErr || !order) {
      await releaseInventoryItems(body.darkstore_id, reserveItems);
      logger.error({ customerId, err: orderErr?.message }, "Order insert failed; reservation rolled back");
      return reply.status(500).send({ error: "Failed to create order" });
    }

    // 4. Create Order Items — also roll back (and delete the order) on failure.
    const orderItems = body.items.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      qty: item.qty,
      unit_price: item.unit_price
    }));

    const { error: itemsErr } = await supabaseAdmin.from("quick_order_items").insert(orderItems);
    if (itemsErr) {
      await releaseInventoryItems(body.darkstore_id, reserveItems);
      await supabaseAdmin.from("quick_orders").delete().eq("id", order.id);
      logger.error({ orderId: order.id, err: itemsErr.message }, "Order items insert failed; order + reservation rolled back");
      return reply.status(500).send({ error: "Failed to create order items" });
    }

    return reply.status(201).send({ message: "Order placed successfully", order });
  });

  // POST /orders/:id/cancel
  app.post("/orders/:id/cancel", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.user!.id;

    const { data: order } = await supabaseAdmin
      .from("quick_orders")
      .select("status")
      .eq("id", id)
      .eq("customer_id", customerId)
      .single();

    if (!order) return reply.status(404).send({ error: "Order not found" });
    if (order.status !== "placed" && order.status !== "accepted") {
      return reply.status(400).send({ error: "Order cannot be cancelled at this stage" });
    }

    await supabaseAdmin
      .from("quick_orders")
      .update({ status: "cancelled" })
      .eq("id", id);

    // Release inventory
    await releaseInventory(id);

    return reply.send({ message: "Order cancelled successfully" });
  });

  // GET /orders (History)
  app.get("/orders", { preHandler: [authGuard] }, async (request, reply) => {
    const customerId = request.user!.id;
    const { data: orders, error } = await supabaseAdmin
      .from("quick_orders")
      .select("*, quick_order_items(product_id, qty, unit_price, products(name, image_url))")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false });

    if (error) return reply.status(500).send({ error: "Failed to fetch orders" });
    return reply.send({ orders });
  });

  // GET /orders/:id — single order (efficient tracking; participant-checked)
  app.get("/orders/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const role = request.user!.role;

    const { data: order, error } = await supabaseAdmin
      .from("quick_orders")
      .select("*, quick_order_items(product_id, qty, unit_price, products(name, image_url))")
      .eq("id", id)
      .single();

    if (error || !order) return reply.status(404).send({ error: "Order not found" });

    // The owning customer, or store_ops/admin, may view it.
    if (order.customer_id !== userId && role !== "store_ops" && role !== "admin") {
      return reply.status(403).send({ error: "Not authorized to view this order" });
    }

    return reply.send({ order });
  });

  // GET /orders/queue — active orders for the store-ops fulfilment queue.
  app.get("/orders/queue", { preHandler: [authGuard, requireRole("store_ops", "admin")] }, async (request, reply) => {
    const { data: orders, error } = await supabaseAdmin
      .from("quick_orders")
      .select("id, status, total, delivery_address, created_at, quick_order_items(qty, products(name))")
      .in("status", ["placed", "accepted", "picking", "packed"])
      .order("created_at", { ascending: true });

    if (error) return reply.status(500).send({ error: "Failed to fetch queue" });
    return reply.send({ orders: orders || [] });
  });

  // --- Store Operations Endpoints (gated to store_ops / admin roles) ---

  app.post("/orders/:id/accept", { preHandler: [authGuard, requireRole("store_ops", "admin")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await updateOrderStatus(id, "accepted");
    return reply.send({ message: "Order accepted by store" });
  });

  app.post("/orders/:id/picking", { preHandler: [authGuard, requireRole("store_ops", "admin")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await updateOrderStatus(id, "picking");
    return reply.send({ message: "Order picking started" });
  });

  app.post("/orders/:id/packed", { preHandler: [authGuard, requireRole("store_ops", "admin")] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // 1. Update status + stamp packed_at for SLA tracking
    await updateOrderStatus(id, "packed", { packed_at: new Date().toISOString() });

    // 2. Fetch order details to trigger dispatch
    const { data: order } = await supabaseAdmin
      .from("quick_orders")
      .select("*, darkstores(lat, lng)")
      .eq("id", id)
      .single();

    if (order && order.darkstores) {
      // Create a "ride" record for the delivery rider
      // We map the darkstore as origin and customer as destination
      const { data: ride, error: rideErr } = await supabaseAdmin
        .from("rides")
        .insert({
          customer_id: order.customer_id, // the person receiving the delivery
          order_id: order.id,             // satisfies check_job_ownership + links back
          origin_lat: order.darkstores.lat,
          origin_lng: order.darkstores.lng,
          origin_address: "Darkstore Pickup",
          dest_lat: order.delivery_lat,
          dest_lng: order.delivery_lng,
          dest_address: order.delivery_address,
          vehicle_type: "bike", // standard for q-commerce
          service_type: "quick",
          fare_estimate: order.delivery_fee,
          status: "requested",
          payment_method: "cash",
          payment_status: "pending"
        })
        .select()
        .single();

      if (rideErr) {
        logger.error({ orderId: id, err: rideErr.message }, "Failed to create delivery ride for packed order");
      }

      if (ride) {
        // Link the ride to the order
        await supabaseAdmin
          .from("quick_orders")
          .update({ ride_id: ride.id })
          .eq("id", id);

        // Trigger rider matching!
        // We pass cargo_weight_kg = 0 since it's just a quick delivery bag
        findNearbyDrivers(order.darkstores.lat, order.darkstores.lng, "bike", ride.id, "quick", 0).catch(() => {});
      }
    }

    return reply.send({ message: "Order packed and dispatch triggered" });
  });

  async function updateOrderStatus(orderId: string, status: string, extra: Record<string, unknown> = {}) {
    await supabaseAdmin
      .from("quick_orders")
      .update({ status, ...extra })
      .eq("id", orderId);

    // Notify customer app
    broadcastOrderStatus(orderId, status).catch(() => {});
  }
}
