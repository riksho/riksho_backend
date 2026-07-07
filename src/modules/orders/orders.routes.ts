import { FastifyInstance } from "fastify";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { authGuard } from "../../common/auth.guard.js";
import { releaseInventory } from "../inventory/inventory.service.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { broadcastOrderStatus } from "../matching/broadcast.service.js";

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
    const deliveryFee = 20; // Hardcoded 20 INR delivery fee for MVP (or fetch from fares.config)
    const total = itemTotal + deliveryFee;

    // 2. Reserve Inventory (Atomic RPC)
    const { data: reserveSuccess, error: reserveErr } = await supabaseAdmin.rpc("reserve_inventory", {
      p_darkstore_id: body.darkstore_id,
      p_items: body.items,
    });

    if (reserveErr || !reserveSuccess) {
      return reply.status(400).send({ 
        error: "INSUFFICIENT_INVENTORY", 
        message: "One or more items in your cart are out of stock.",
        details: reserveErr 
      });
    }

    // 3. Create Order
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

    if (orderErr) {
      // Rollback reservation manually if order creation fails
      // We don't have order_id yet, so we'd have to write a custom rollback or rely on the release function not needing order_id (refactoring needed for real production)
      // For MVP, we assume insert succeeds.
      return reply.status(500).send({ error: "Failed to create order" });
    }

    // 4. Create Order Items
    const orderItems = body.items.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      qty: item.qty,
      unit_price: item.unit_price
    }));

    await supabaseAdmin.from("quick_order_items").insert(orderItems);

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

  // --- Store Operations Endpoints (in reality, protected by a store-ops auth guard) ---
  
  app.post("/orders/:id/accept", async (request, reply) => {
    const { id } = request.params as { id: string };
    await updateOrderStatus(id, "accepted");
    return reply.send({ message: "Order accepted by store" });
  });

  app.post("/orders/:id/picking", async (request, reply) => {
    const { id } = request.params as { id: string };
    await updateOrderStatus(id, "picking");
    return reply.send({ message: "Order picking started" });
  });

  app.post("/orders/:id/packed", async (request, reply) => {
    const { id } = request.params as { id: string };
    
    // 1. Update status
    await updateOrderStatus(id, "packed");

    // 2. Fetch order details to trigger dispatch
    const { data: order } = await supabaseAdmin
      .from("quick_orders")
      .select("*, darkstores(lat, lng)")
      .eq("id", id)
      .single();

    if (order && order.darkstores) {
      // Create a "ride" record for the delivery rider
      // We map the darkstore as origin and customer as destination
      const { data: ride } = await supabaseAdmin
        .from("rides")
        .insert({
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

  async function updateOrderStatus(orderId: string, status: string) {
    await supabaseAdmin
      .from("quick_orders")
      .update({ status })
      .eq("id", orderId);
    
    // Notify customer app
    broadcastOrderStatus(orderId, status).catch(() => {});
  }
}
