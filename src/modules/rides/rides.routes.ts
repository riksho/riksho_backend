import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import * as crypto from "node:crypto";
import { authGuard } from "../../common/auth.guard.js";
import { requireRole } from "../../common/roles.guard.js";
import { logger } from "../../common/logger.js";
import { supabaseAdmin } from "../../config/supabase.js";
import {
  calculateFare,
  clampOfferedFare,
  effectiveFare,
  type VehicleType,
} from "../fares/fares.config.js";
import { findNearbyDrivers } from "../matching/matching.service.js";
import { broadcastRideStatus, broadcastOrderStatus, broadcastDriverBid, broadcastBidResult } from "../matching/broadcast.service.js";
import { sendPush } from "../notifications/push.service.js";
import { fireWebhook } from "../notifications/webhook.service.js";
import {
  RideRequestSchema,
  RideCancelSchema,
  RideCompleteSchema,
} from "../../common/schemas.js";

export async function ridesRoutes(app: FastifyInstance) {
  // POST /rides — Request a ride (customers only)
  app.post("/rides", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const customerId = request.user!.id;
    const body = RideRequestSchema.parse(request.body);

    // Calculate route via OSRM
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json() as { routes?: Array<{ distance: number; duration: number }> };

    if (!routeData.routes || routeData.routes.length === 0) {
      return reply.status(400).send({ error: "Could not calculate route" });
    }

    const route = routeData.routes[0];

    // Reject intercity rides beyond local operating radius (> 65 km)
    if (route.distance > 65000) {
      return reply.status(400).send({
        error: "INTERCITY_NOT_ALLOWED",
        message: "Intercity rides are not supported. Please choose a destination within your local city.",
      });
    }

    const fareEstimate = calculateFare(body.vehicle_type, route.distance, route.duration);

    // Honour the customer's offered fare from the find-ride stepper (fix A3), but
    // never trust it: clamp to 0.8x–2.0x of our own estimate. Bidding is a "move"
    // concept only — fleet is contract-priced and quick is fee-priced, so we ignore
    // any offered_fare on those and let them settle against fare_estimate.
    const offeredFare =
      body.offered_fare !== undefined && body.service_type === "move"
        ? clampOfferedFare(body.offered_fare, fareEstimate)
        : null;

    if (offeredFare !== null && offeredFare !== Math.round(body.offered_fare!)) {
      logger.info(
        { customerId, requested: body.offered_fare, clamped: offeredFare, fareEstimate },
        "Offered fare clamped to allowed band"
      );
    }

    // Create ride record
    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .insert({
        customer_id: customerId,
        status: "requested",
        vehicle_type: body.vehicle_type,
        origin_lat: body.origin_lat,
        origin_lng: body.origin_lng,
        origin_address: body.origin_address,
        dest_lat: body.dest_lat,
        dest_lng: body.dest_lng,
        dest_address: body.dest_address,
        service_type: body.service_type,
        cargo_weight_kg: body.cargo_weight_kg,
        distance_m: Math.round(route.distance),
        duration_s: Math.round(route.duration),
        fare_estimate: fareEstimate,
        offered_fare: offeredFare,
        ride_otp: body.service_type === "move" ? crypto.randomInt(1000, 10000).toString() : null,
        payment_method: "cash",
        payment_status: "pending",
      })
      .select()
      .single();

    if (error) {
      return reply.status(500).send({ error: "Failed to create ride" });
    }

    // Log ride event
    await supabaseAdmin.from("ride_events").insert({
      ride_id: ride.id,
      type: "requested",
      payload: { customer_id: customerId, vehicle_type: body.vehicle_type, service_type: body.service_type },
    });

    // Find nearby drivers and notify them (async — don't await)
    findNearbyDrivers(body.origin_lat, body.origin_lng, body.vehicle_type, ride.id, body.service_type, body.cargo_weight_kg).catch(() => {});

    return reply.status(201).send({
      ride_id: ride.id,
      status: ride.status,
      fare_estimate: fareEstimate,
      // Echo the *clamped* value so the customer app can correct its display if
      // the stepper went outside the allowed band, rather than showing a fare the
      // server never accepted.
      offered_fare: offeredFare,
      distance_km: +(route.distance / 1000).toFixed(1),
      duration_min: Math.round(route.duration / 60),
    });
  });

  // POST /rides/estimate — Get fare estimate (customers only)
  app.post("/rides/estimate", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const { RideEstimateSchema } = await import("../../common/schemas.js");
    const body = RideEstimateSchema.parse(request.body);

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
    const routeRes = await fetch(osrmUrl);
    const routeData = await routeRes.json() as { routes?: Array<{ distance: number; duration: number }> };

    if (!routeData.routes || routeData.routes.length === 0) {
      return reply.status(400).send({ error: "Could not calculate route" });
    }

    const route = routeData.routes[0];
    const distanceKm = +(route.distance / 1000).toFixed(1);
    const durationMin = Math.round(route.duration / 60);

    // Return estimates for all vehicle types so the customer can pick
    const estimates: Record<string, number> = {
      bike: calculateFare("bike", route.distance, route.duration),
      auto: calculateFare("auto", route.distance, route.duration),
      e_rickshaw: calculateFare("e_rickshaw", route.distance, route.duration),
      car: calculateFare("car", route.distance, route.duration),
      tempo: calculateFare("tempo", route.distance, route.duration),
      mini_truck: calculateFare("mini_truck", route.distance, route.duration),
      truck: calculateFare("truck", route.distance, route.duration),
    };

    return reply.send({
      distance_km: distanceKm,
      duration_min: durationMin,
      estimates,
      // Also return the specific type if requested
      fare_estimate: estimates[body.vehicle_type],
      vehicle_type: body.vehicle_type,
    });
  });

  // GET /rides/:id — Get ride details
  app.get("/rides/:id", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;

    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .select("*, ride_events(*)")
      .eq("id", id)
      .single();

    if (error || !ride) {
      return reply.status(404).send({ error: "Ride not found" });
    }

    // Only allow the ride's customer or assigned driver to see it
    if (ride.customer_id !== userId && ride.driver_id !== userId) {
      return reply.status(403).send({ error: "Not authorized to view this ride" });
    }

    // Never leak OTP to the driver (B2)
    if (ride.customer_id !== userId) {
      delete ride.ride_otp;
    }

    // B6: Append customer name and phone so driver app can call the customer
    if (ride.driver_id === userId || request.user!.role === "driver") {
      const { data: customer } = await supabaseAdmin
        .from("users")
        .select("name, phone")
        .eq("id", ride.customer_id)
        .single();
        
      if (customer) {
        ride.customer_phone = customer.phone;
        ride.customer_name = customer.name || "Customer";
      }
    }

    // Append driver info if customer is calling
    if (ride.customer_id === userId && ride.driver_id) {
      const { data: driverInfo } = await supabaseAdmin
        .from("drivers")
        .select("name, phone, rating, vehicles!vehicles_driver_id_fkey(type, plate, model)")
        .eq("id", ride.driver_id)
        .single();
        
      if (driverInfo) {
        const v = Array.isArray(driverInfo.vehicles) ? driverInfo.vehicles[0] : driverInfo.vehicles;
        ride.driver_name = driverInfo.name || "Driver";
        ride.driver_phone = driverInfo.phone;
        ride.driver_rating = driverInfo.rating;
        ride.vehicle_type = v?.type;
        ride.vehicle_plate = v?.plate;
        ride.vehicle_model = v?.model;
      }
    }

    // Append active bids if customer is viewing a requested ride
    if (ride.customer_id === userId && ride.status === "requested") {
      const { data: activeBids } = await supabaseAdmin
        .from("ride_bids")
        .select("id, driver_id, amount, eta_min, status, drivers!ride_bids_driver_id_fkey(name, rating, vehicles!vehicles_driver_id_fkey(plate, model))")
        .eq("ride_id", id)
        .eq("status", "active");

      if (activeBids && activeBids.length > 0) {
        const driverIds = activeBids.map((b: any) => b.driver_id);
        const { data: profileDocs } = await supabaseAdmin
          .from("driver_documents")
          .select("driver_id, storage_path")
          .in("driver_id", driverIds)
          .eq("doc_type", "profile_photo");

        const avatarMap = new Map<string, string>();
        if (profileDocs && profileDocs.length > 0) {
          await Promise.allSettled(
            profileDocs.map(async (doc) => {
              if (doc.storage_path) {
                const { data: signed } = await supabaseAdmin.storage
                  .from("documents")
                  .createSignedUrl(doc.storage_path, 3600);
                if (signed?.signedUrl) {
                  avatarMap.set(doc.driver_id, signed.signedUrl);
                }
              }
            })
          );
        }

        ride.bids = activeBids.map((b: any) => {
          const d = b.drivers;
          const v = d?.vehicles ? (Array.isArray(d.vehicles) ? d.vehicles[0] : d.vehicles) : null;
          return {
            bid_id: b.id,
            driver_id: b.driver_id,
            driver_name: d?.name || "Driver",
            driver_rating: d?.rating ?? null,
            driver_avatar: avatarMap.get(b.driver_id) || null,
            vehicle_plate: v?.plate,
            vehicle_model: v?.model,
            amount: Number(b.amount),
            eta_min: b.eta_min,
          };
        });
      }
    }

    return reply.send(ride);
  });

  // GET /rides — Ride history
  app.get("/rides", { preHandler: [authGuard] }, async (request, reply) => {
    const userId = request.user!.id;
    const role = request.user!.role;

    let query = supabaseAdmin
      .from("rides")
      .select("*")
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(50);

    if (role === "driver") {
      query = query.eq("driver_id", userId);
    } else {
      query = query.eq("customer_id", userId);
    }

    const { data: ridesList, error } = await query;

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch rides" });
    }

    if (!ridesList || ridesList.length === 0) {
      return reply.send([]);
    }

    // Populate driver/vehicle details for customer history
    const driverIds = [...new Set(ridesList.map((r: any) => r.driver_id).filter(Boolean))];
    const driverMap = new Map<string, any>();

    if (driverIds.length > 0) {
      const { data: drivers } = await supabaseAdmin
        .from("drivers")
        .select("id, name, phone, rating, vehicles!vehicles_driver_id_fkey(type, plate, model, seats)")
        .in("id", driverIds);

      if (drivers) {
        drivers.forEach((d: any) => {
          const v = Array.isArray(d.vehicles) ? d.vehicles[0] : d.vehicles;
          const nameParts = (d.name || "Driver").trim().split(" ");
          driverMap.set(d.id, {
            name: d.name || "Driver",
            first_name: nameParts[0] || "Driver",
            last_name: nameParts.slice(1).join(" ") || "",
            phone: d.phone,
            rating: d.rating,
            car_seats: v?.seats || 3,
            vehicle_type: v?.type || "auto",
            vehicle_plate: v?.plate || "MH 01 AB 1234",
            vehicle_model: v?.model || "Standard Auto",
          });
        });
      }
    }

    const formatted = ridesList.map((r: any) => {
      const driver = driverMap.get(r.driver_id) || {
        first_name: "Driver",
        last_name: "",
        car_seats: 3,
        vehicle_model: "Auto",
        vehicle_plate: "",
        name: "Driver",
      };

      return {
        ...r,
        destination_latitude: r.dest_lat ?? r.destination_latitude ?? 22.5726,
        destination_longitude: r.dest_lng ?? r.destination_longitude ?? 88.3639,
        origin_latitude: r.origin_lat ?? r.origin_latitude ?? 22.5726,
        origin_longitude: r.origin_lng ?? r.origin_longitude ?? 88.3639,
        destination_address: r.dest_address ?? r.destination_address ?? "Destination",
        origin_address: r.origin_address ?? "Pickup Location",
        driver: {
          first_name: driver.first_name,
          last_name: driver.last_name,
          car_seats: driver.car_seats,
          phone: driver.phone,
        },
        driver_name: driver.name,
        vehicle_model: driver.vehicle_model,
        vehicle_plate: driver.vehicle_plate,
        payment_status: r.payment_status || "paid",
        ride_time: r.ride_time || 15,
      };
    });

    return reply.send(formatted);
  });

  // POST /rides/:id/fare — Update offered fare and re-trigger matching
  app.post("/rides/:id/fare", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.user!.id;
    
    const FareUpdateSchema = z.object({
      extra_amount: z.number().min(1),
    });
    
    const body = FareUpdateSchema.parse(request.body);

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("status, customer_id, offered_fare, fare_estimate, origin_lat, origin_lng, vehicle_type, service_type, cargo_weight_kg")
      .eq("id", id)
      .single();

    if (!ride || ride.customer_id !== customerId) {
      return reply.status(403).send({ error: "Not authorized to update this ride" });
    }

    if (ride.status !== "requested") {
      return reply.status(400).send({ error: "Can only update fare for requested rides" });
    }

    const currentFare = ride.offered_fare ?? ride.fare_estimate;
    const newFare = currentFare + body.extra_amount;

    // Update offered_fare
    const { error } = await supabaseAdmin
      .from("rides")
      .update({ offered_fare: newFare })
      .eq("id", id);

    if (error) {
      return reply.status(500).send({ error: "Failed to update fare" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "fare_updated",
      payload: { old_fare: currentFare, new_fare: newFare, extra_amount: body.extra_amount },
    });

    // Clear previous declines so drivers who declined the lower fare get re-alerted
    await supabaseAdmin
      .from("ride_declines")
      .delete()
      .eq("ride_id", id);

    // Re-trigger matching to notify drivers of the updated fare
    findNearbyDrivers(
      ride.origin_lat,
      ride.origin_lng,
      ride.vehicle_type,
      id,
      ride.service_type,
      ride.cargo_weight_kg
    ).catch(() => {});

    return reply.send({ success: true, offered_fare: newFare });
  });

  // POST /rides/:id/retry — Re-trigger driver matching (customer only)
  app.post("/rides/:id/retry", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.user!.id;

    const { data: ride, error } = await supabaseAdmin
      .from("rides")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !ride) {
      return reply.status(404).send({ error: "Ride not found" });
    }

    if (ride.customer_id !== customerId) {
      return reply.status(403).send({ error: "Not authorized" });
    }

    if (ride.status !== "requested") {
      return reply.status(400).send({ error: "Ride is no longer in requested state" });
    }

    // Log retry event
    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "retry",
      payload: { customer_id: customerId },
    });

    // Clear previous declines so all drivers get re-alerted
    await supabaseAdmin
      .from("ride_declines")
      .delete()
      .eq("ride_id", id);

    // Re-trigger matching to notify drivers
    findNearbyDrivers(
      ride.origin_lat,
      ride.origin_lng,
      ride.vehicle_type,
      id,
      ride.service_type,
      ride.cargo_weight_kg
    ).catch(() => {});

    return reply.send({ success: true });
  });

  // POST /rides/:id/cancel — Cancel a ride (participant check)
  app.post("/rides/:id/cancel", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const body = RideCancelSchema.parse(request.body ?? {});

    // First: verify the caller is a participant
    const { data: existingRide } = await supabaseAdmin
      .from("rides")
      .select("customer_id, driver_id, status")
      .eq("id", id)
      .single();

    if (!existingRide) {
      return reply.status(404).send({ error: "Ride not found" });
    }

    if (existingRide.customer_id !== userId && existingRide.driver_id !== userId) {
      return reply.status(403).send({ error: "Not authorized to cancel this ride" });
    }

    // Determine who is cancelling
    const cancelledBy = existingRide.customer_id === userId ? "customer" : "driver";

    // Atomic: only cancel if in a cancellable state
    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        cancel_reason: body.reason || null,
        cancelled_by: cancelledBy,
      })
      .eq("id", id)
      .in("status", ["requested", "accepted", "arriving"])
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Ride cannot be cancelled in its current state" });
    }

    // If a driver had already been assigned (accepted/arriving), reset them to
    // online so they can receive new offers. Without this, the driver remains
    // stuck as on_trip and silently stops getting matched.
    if (data.driver_id) {
      await supabaseAdmin
        .from("drivers")
        .update({ status: "online" })
        .eq("id", data.driver_id);
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "cancelled",
      payload: { cancelled_by: cancelledBy, reason: body.reason },
    });

    // Broadcast cancellation to the other party
    broadcastRideStatus(id, "cancelled", { cancelled_by: cancelledBy });
    syncQuickOrder(id, "cancelled").catch(() => {});
    notifyBusinessWebhook(id, "cancelled", { cancelled_by: cancelledBy }).catch(() => {});

    // Edge case #9: Reject all active bids and notify every bidding driver
    const { data: activeBids } = await supabaseAdmin
      .from("ride_bids")
      .select("id, driver_id")
      .eq("ride_id", id)
      .eq("status", "active");

    if (activeBids && activeBids.length > 0) {
      await supabaseAdmin
        .from("ride_bids")
        .update({ status: "rejected" })
        .eq("ride_id", id)
        .eq("status", "active");

      await Promise.allSettled(
        activeBids.map((bid) => broadcastBidResult(bid.driver_id, id, "bid_rejected"))
      );
    }

    // Push-notify the other party so they know even if backgrounded
    const notifyUserId = cancelledBy === "customer" ? data.driver_id : data.customer_id;
    if (notifyUserId) {
      sendPush([notifyUserId], {
        title: "Ride Cancelled",
        body: cancelledBy === "customer"
          ? "The customer cancelled this ride."
          : "The driver cancelled this ride.",
        data: { ride_id: id, status: "cancelled" },
      }).catch(() => {});
    }

    return reply.send({ status: "cancelled" });
  });

  // POST /rides/:id/cancel-reason — Update cancellation reason feedback
  app.post("/rides/:id/cancel-reason", { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) ?? {};

    if (reason) {
      await supabaseAdmin
        .from("rides")
        .update({ cancel_reason: reason })
        .eq("id", id);
    }

    return reply.send({ success: true });
  });

  // POST /rides/:id/decline — Driver declines the ride
  app.post("/rides/:id/decline", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    // Verify ride is still requested
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("status")
      .eq("id", id)
      .single();

    if (!ride || ride.status !== "requested") {
      // It's not requested anymore (someone else took it or cancelled), just ack
      return reply.send({ status: "ignored" });
    }

    // Insert decline record so matching service can exclude this driver
    await supabaseAdmin
      .from("ride_declines")
      .insert({ ride_id: id, driver_id: driverId })
      .select()
      .single();

    return reply.send({ status: "declined" });
  });

  // POST /rides/:id/accept — Driver accepts at the offered price.
  // In the bidding model this is a convenience alias: it submits a bid at the
  // exact offered fare rather than atomically claiming the ride. The customer
  // picks from the bid list via POST /rides/:id/select-bid.
  app.post("/rides/:id/accept", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    // Verify ride is still requestable
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("status, fare_estimate, offered_fare")
      .eq("id", id)
      .single();

    if (!ride || ride.status !== "requested") {
      return reply.status(409).send({ error: "Ride already taken or not available" });
    }

    // Check this driver hasn't been excluded
    const { data: declined } = await supabaseAdmin
      .from("ride_declines")
      .select("id")
      .eq("ride_id", id)
      .eq("driver_id", driverId)
      .maybeSingle();

    if (declined) {
      return reply.status(403).send({ error: "You previously declined this ride" });
    }

    const bidAmount = Number(ride.offered_fare ?? ride.fare_estimate);

    // Fetch driver info for the broadcast
    const { data: driverInfo } = await supabaseAdmin
      .from("drivers")
      .select("name, rating, vehicles!vehicles_driver_id_fkey(type, plate, model)")
      .eq("id", driverId)
      .single();

    const v = driverInfo?.vehicles
      ? (Array.isArray(driverInfo.vehicles) ? driverInfo.vehicles[0] : driverInfo.vehicles)
      : null;

    // Upsert bid (driver accepts at the offered price)
    const { data: bid, error: bidError } = await supabaseAdmin
      .from("ride_bids")
      .upsert(
        {
          ride_id: id,
          driver_id: driverId,
          amount: bidAmount,
          status: "active",
        },
        { onConflict: "ride_id,driver_id" }
      )
      .select()
      .single();

    if (bidError || !bid) {
      logger.error({ rideId: id, driverId, err: bidError }, "Failed to upsert bid on accept");
      return reply.status(500).send({ error: "Failed to submit bid" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "bid_submitted",
      payload: { driver_id: driverId, amount: bidAmount, via: "accept" },
    });

    // Broadcast driver bid to customer's live list
    broadcastDriverBid(id, {
      bid_id: bid.id,
      driver_id: driverId,
      driver_name: driverInfo?.name || "Driver",
      driver_rating: driverInfo?.rating ?? null,
      vehicle_plate: v?.plate,
      vehicle_model: v?.model,
      amount: bidAmount,
    });

    return reply.send({ status: "bid_submitted", bid_id: bid.id, amount: bidAmount });
  });

  // POST /rides/:id/bid — Driver submits or updates a bid (counter-offer)
  app.post("/rides/:id/bid", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    const BidSchema = z.object({
      amount: z.number().positive().max(100_000),
      eta_min: z.number().int().min(1).max(120).optional(),
    });
    const body = BidSchema.parse(request.body);

    // Verify ride is still requestable
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("status, fare_estimate, offered_fare")
      .eq("id", id)
      .single();

    if (!ride || ride.status !== "requested") {
      return reply.status(409).send({ error: "Ride already taken or not available" });
    }

    // Rate-limit: check if driver submitted a bid in the last 2 seconds
    const { data: recentBid } = await supabaseAdmin
      .from("ride_bids")
      .select("updated_at")
      .eq("ride_id", id)
      .eq("driver_id", driverId)
      .maybeSingle();

    if (recentBid?.updated_at) {
      const lastUpdate = new Date(recentBid.updated_at).getTime();
      if (Date.now() - lastUpdate < 2000) {
        return reply.status(429).send({ error: "Please wait a moment before updating your bid" });
      }
    }

    // Check this driver hasn't been excluded
    const { data: declined } = await supabaseAdmin
      .from("ride_declines")
      .select("id")
      .eq("ride_id", id)
      .eq("driver_id", driverId)
      .maybeSingle();

    if (declined) {
      return reply.status(403).send({ error: "You previously declined this ride" });
    }

    // Clamp the bid amount using the same logic as customer fares (0.8x - 2.0x)
    const fareEstimate = Number(ride.fare_estimate);
    const clampedAmount = clampOfferedFare(body.amount, fareEstimate);

    // Fetch driver info and profile photo for the broadcast
    const { data: driverInfo } = await supabaseAdmin
      .from("drivers")
      .select("name, rating, vehicles!vehicles_driver_id_fkey(type, plate, model)")
      .eq("id", driverId)
      .single();

    const { data: profileDoc } = await supabaseAdmin
      .from("driver_documents")
      .select("storage_path")
      .eq("driver_id", driverId)
      .eq("doc_type", "profile_photo")
      .maybeSingle();

    let driverAvatar: string | null = null;
    if (profileDoc?.storage_path) {
      const { data: signed } = await supabaseAdmin.storage
        .from("documents")
        .createSignedUrl(profileDoc.storage_path, 3600);
      if (signed?.signedUrl) {
        driverAvatar = signed.signedUrl;
      }
    }

    const v = driverInfo?.vehicles
      ? (Array.isArray(driverInfo.vehicles) ? driverInfo.vehicles[0] : driverInfo.vehicles)
      : null;

    // Upsert bid
    const { data: bid, error: bidError } = await supabaseAdmin
      .from("ride_bids")
      .upsert(
        {
          ride_id: id,
          driver_id: driverId,
          amount: clampedAmount,
          eta_min: body.eta_min ?? null,
          status: "active",
        },
        { onConflict: "ride_id,driver_id" }
      )
      .select()
      .single();

    if (bidError || !bid) {
      logger.error({ rideId: id, driverId, err: bidError }, "Failed to upsert bid");
      return reply.status(500).send({ error: "Failed to submit bid" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "bid_submitted",
      payload: { driver_id: driverId, amount: clampedAmount, eta_min: body.eta_min, original_amount: body.amount },
    });

    // Broadcast driver bid to customer's live list
    broadcastDriverBid(id, {
      bid_id: bid.id,
      driver_id: driverId,
      driver_name: driverInfo?.name || "Driver",
      driver_rating: driverInfo?.rating ?? null,
      driver_avatar: driverAvatar,
      vehicle_plate: v?.plate,
      vehicle_model: v?.model,
      amount: clampedAmount,
      eta_min: body.eta_min ?? null,
    });

    return reply.send({
      status: "bid_submitted",
      bid_id: bid.id,
      amount: clampedAmount,
      clamped: clampedAmount !== Math.round(body.amount),
    });
  });

  // POST /rides/:id/select-bid — Customer selects a driver from the bid list
  app.post("/rides/:id/select-bid", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.user!.id;

    const SelectBidSchema = z.object({
      bid_id: z.string().uuid(),
    });
    const body = SelectBidSchema.parse(request.body);

    // Fetch the winning bid
    const { data: winningBid } = await supabaseAdmin
      .from("ride_bids")
      .select("id, driver_id, amount, ride_id, status")
      .eq("id", body.bid_id)
      .eq("ride_id", id)
      .eq("status", "active")
      .single();

    if (!winningBid) {
      return reply.status(404).send({ error: "Bid not found or already resolved" });
    }

    // Atomic: assign the ride to this driver (same locking pattern as the old accept)
    const { data: updatedRide, error: rideError } = await supabaseAdmin
      .from("rides")
      .update({
        driver_id: winningBid.driver_id,
        status: "accepted",
        accepted_at: new Date().toISOString(),
        offered_fare: winningBid.amount, // Lock fare to the winning bid amount
      })
      .eq("id", id)
      .eq("customer_id", customerId)
      .eq("status", "requested")
      .is("driver_id", null)
      .select()
      .single();

    if (rideError || !updatedRide) {
      return reply.status(409).send({ error: "Ride already assigned or cancelled" });
    }

    // Mark winning bid
    await supabaseAdmin
      .from("ride_bids")
      .update({ status: "won" })
      .eq("id", winningBid.id);

    // Reject all other active bids for this ride
    const { data: rejectedBids } = await supabaseAdmin
      .from("ride_bids")
      .update({ status: "rejected" })
      .eq("ride_id", id)
      .eq("status", "active")
      .neq("id", winningBid.id)
      .select("driver_id");

    // Update winning driver status to on_trip
    await supabaseAdmin.from("drivers").update({ status: "on_trip" }).eq("id", winningBid.driver_id);

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "accepted",
      payload: { driver_id: winningBid.driver_id, bid_id: winningBid.id, amount: winningBid.amount },
    });

    // Fetch driver/vehicle info for the customer broadcast
    const { data: driverInfo } = await supabaseAdmin
      .from("drivers")
      .select("name, phone, rating, vehicles!vehicles_driver_id_fkey(type, plate, model)")
      .eq("id", winningBid.driver_id)
      .single();

    let vType, vPlate, vModel;
    if (driverInfo?.vehicles) {
      const veh = Array.isArray(driverInfo.vehicles) ? driverInfo.vehicles[0] : driverInfo.vehicles;
      vType = veh?.type;
      vPlate = veh?.plate;
      vModel = veh?.model;
    }

    const acceptPayload = {
      driver_id: winningBid.driver_id,
      driver_name: driverInfo?.name || "Driver",
      driver_phone: driverInfo?.phone,
      driver_rating: driverInfo?.rating,
      vehicle_type: vType,
      vehicle_plate: vPlate,
      vehicle_model: vModel,
    };

    // Broadcast acceptance to customer (same contract as before — searching.tsx already handles this)
    broadcastRideStatus(id, "accepted", acceptPayload);
    notifyBusinessWebhook(id, "accepted", { driver_id: winningBid.driver_id }).catch(() => {});

    // Notify winning driver
    broadcastBidResult(winningBid.driver_id, id, "bid_won");
    sendPush([winningBid.driver_id], {
      title: "Bid Accepted!",
      body: "The rider chose your offer. Head to the pickup location.",
      data: { ride_id: id, status: "bid_won" },
    }).catch(() => {});

    // Notify rejected drivers
    if (rejectedBids && rejectedBids.length > 0) {
      await Promise.allSettled(
        rejectedBids.map((b) => broadcastBidResult(b.driver_id, id, "bid_rejected"))
      );
    }

    // Push to customer
    sendPush([customerId], {
      title: "Driver Confirmed",
      body: "Your driver is on the way to the pickup location.",
      data: { ride_id: id, status: "accepted" },
    }).catch(() => {});

    return reply.send({ status: "accepted", ride: updatedRide });
  });

  // POST /rides/:id/withdraw-bid — Driver withdraws their bid before customer selects
  app.post("/rides/:id/withdraw-bid", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    const { data: bid, error } = await supabaseAdmin
      .from("ride_bids")
      .update({ status: "withdrawn" })
      .eq("ride_id", id)
      .eq("driver_id", driverId)
      .eq("status", "active")
      .select()
      .single();

    if (error || !bid) {
      return reply.status(404).send({ error: "No active bid to withdraw" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "bid_withdrawn",
      payload: { driver_id: driverId, bid_id: bid.id },
    });

    // Broadcast withdrawal to customer so their UI removes the card
    broadcastDriverBid(id, {
      bid_id: bid.id,
      driver_id: driverId,
      driver_name: "",
      driver_rating: null,
      amount: 0,
      withdrawn: true,
    });

    return reply.send({ status: "withdrawn" });
  });

  // POST /rides/:id/reject-bid — Customer rejects an individual driver's bid
  app.post("/rides/:id/reject-bid", { preHandler: [authGuard, requireRole("customer")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.user!.id;

    const RejectBidSchema = z.object({
      bid_id: z.string().uuid(),
    });
    const body = RejectBidSchema.parse(request.body);

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("id, status, customer_id")
      .eq("id", id)
      .single();

    if (!ride || ride.customer_id !== customerId) {
      return reply.status(403).send({ error: "Not authorized to reject bids on this ride" });
    }

    const { data: bid, error } = await supabaseAdmin
      .from("ride_bids")
      .update({ status: "rejected" })
      .eq("id", body.bid_id)
      .eq("ride_id", id)
      .eq("status", "active")
      .select("driver_id, amount")
      .single();

    if (error || !bid) {
      return reply.status(404).send({ error: "Bid not found or already resolved" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "bid_rejected_by_customer",
      payload: { driver_id: bid.driver_id, bid_id: body.bid_id },
    });

    // Notify driver that their bid was declined so they can bid again
    broadcastBidResult(bid.driver_id, id, "bid_rejected");

    return reply.send({ status: "bid_rejected", bid_id: body.bid_id });
  });

  // POST /rides/:id/arrived — Driver arrived at pickup
  app.post("/rides/:id/arrived", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "arriving", arrived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "accepted")
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "arrived", payload: {} });

    // Broadcast to customer: driver arriving
    broadcastRideStatus(id, "arriving", {});
    syncQuickOrder(id, "arriving").catch(() => {});
    notifyBusinessWebhook(id, "arriving").catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Driver Arrived",
        body: "Your driver has arrived at the pickup location.",
        data: { ride_id: id, status: "arriving" },
      }).catch(() => {});
    }

    return reply.send({ status: "arriving" });
  });

  // POST /rides/:id/arrival-override — Driver bypassed the 100m arrival geofence
  //
  // The partner app disables "I've Arrived" / "Complete Trip" until the driver is
  // within 100m of the target (see lib/arrival.ts). That gate has to have an escape
  // hatch: urban multipath, basement parking and mall pickups routinely report a
  // fix hundreds of metres off while the driver stands at the door, and without a
  // bypass those trips dead-end for both parties.
  //
  // This records the bypass so misuse is measurable rather than invisible. It is
  // audit-only — it does NOT transition the ride, so a driver gains nothing by
  // calling it directly; they still have to hit /arrived or /complete, which
  // enforce their own state guards.
  app.post("/rides/:id/arrival-override", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;

    const OverrideSchema = z.object({
      reported_distance_m: z.number().nullable().optional(),
      accuracy_m: z.number().nullable().optional(),
      phase: z.enum(["pickup", "dropoff"]).nullable().optional(),
    });
    const body = OverrideSchema.parse(request.body ?? {});

    // Scope to the assigned driver so one driver cannot write audit rows against
    // another driver's ride.
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("id, driver_id")
      .eq("id", id)
      .eq("driver_id", driverId)
      .single();

    if (!ride) {
      return reply.status(404).send({ error: "Ride not found" });
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "arrival_override",
      payload: {
        driver_id: driverId,
        reported_distance_m: body.reported_distance_m ?? null,
        accuracy_m: body.accuracy_m ?? null,
        phase: body.phase ?? null,
      },
    });

    return reply.send({ ok: true });
  });

  // POST /rides/:id/verify-otp — Driver submits OTP to start trip
  app.post("/rides/:id/verify-otp", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const VerifySchema = z.object({ otp: z.string().length(4) });
    const body = VerifySchema.parse(request.body);

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("ride_otp, otp_attempts, driver_id, status, service_type, customer_id")
      .eq("id", id)
      .single();

    if (!ride || ride.driver_id !== driverId) {
      return reply.status(403).send({ error: "Not authorized" });
    }

    if (ride.status !== "arriving") {
      return reply.status(409).send({ error: "Driver must arrive first" });
    }
    
    if (ride.service_type !== "move") {
      return reply.status(400).send({ error: "OTP verification only applies to passenger rides" });
    }

    if (ride.otp_attempts >= 5) {
      return reply.status(429).send({ error: "Too many failed attempts. Contact support." });
    }

    if (ride.ride_otp !== body.otp) {
      await supabaseAdmin.from("rides").update({ otp_attempts: ride.otp_attempts + 1 }).eq("id", id);
      return reply.status(400).send({ error: "Invalid OTP" });
    }

    // OTP verified — transition to in_progress
    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) {
      return reply.status(500).send({ error: "Failed to start ride" });
    }

    await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "started", payload: { otp_verified: true } });

    broadcastRideStatus(id, "in_progress", {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Trip Started",
        body: "Your trip has started.",
        data: { ride_id: id, status: "in_progress" },
      }).catch(() => {});
    }

    return reply.send({ status: "in_progress" });
  });

  // POST /rides/:id/start — Start the trip
  app.post("/rides/:id/start", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    
    // First check if it's a move ride, which MUST use verify-otp instead
    const { data: rideCheck } = await supabaseAdmin
      .from("rides")
      .select("service_type")
      .eq("id", id)
      .single();
      
    if (rideCheck?.service_type === "move") {
      return reply.status(400).send({ error: "OTP verification required for passenger rides. Use /verify-otp" });
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "arriving")
      .select()
      .single();

    if (error || !data) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    await supabaseAdmin.from("ride_events").insert({ ride_id: id, type: "started", payload: {} });

    // Broadcast to customer: trip started
    broadcastRideStatus(id, "in_progress", {});
    syncQuickOrder(id, "in_progress").catch(() => {});
    notifyBusinessWebhook(id, "in_progress").catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Trip Started",
        body: "Your trip has started.",
        data: { ride_id: id, status: "in_progress" },
      }).catch(() => {});
    }

    return reply.send({ status: "in_progress" });
  });

  // POST /rides/:id/complete — Complete the trip (server-side fare recompute)
  app.post("/rides/:id/complete", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const body = RideCompleteSchema.parse(request.body ?? {});

    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("fare_estimate, offered_fare, distance_m, duration_s, vehicle_type, dest_lat, dest_lng")
      .eq("id", id)
      .eq("driver_id", driverId)
      .eq("status", "in_progress")
      .single();

    if (!ride) {
      return reply.status(409).send({ error: "Invalid state transition" });
    }

    // Server-side location sanity check: verify driver is reasonably close to destination
    try {
      const { data: driverLoc } = await supabaseAdmin
        .from("driver_locations")
        .select("lat, lng")
        .eq("driver_id", driverId)
        .single();
        
      if (driverLoc && ride.dest_lat && ride.dest_lng) {
        const toRad = (value: number) => (value * Math.PI) / 180;
        const R = 6371e3; // meters
        const dLat = toRad(ride.dest_lat - driverLoc.lat);
        const dLng = toRad(ride.dest_lng - driverLoc.lng);
        const lat1 = toRad(driverLoc.lat);
        const lat2 = toRad(ride.dest_lat);

        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        // If completing more than 2km away from destination, log an anomaly
        if (distance > 2000) {
          console.warn(`[ANOMALY] Driver ${driverId} completed ride ${id} ${Math.round(distance)}m away from destination.`);
          await supabaseAdmin.from("ride_events").insert({
            ride_id: id,
            type: "anomaly",
            payload: { reason: "early_completion", distance_m: Math.round(distance), driver_lat: driverLoc.lat, driver_lng: driverLoc.lng }
          });
        }
      }
    } catch (err) {
      console.error("Failed to verify driver location at completion:", err);
    }

    // The agreed fare is what the customer offered (already clamped at request
    // time) or, absent a bid, our estimate. Fix A3: this clamp used to be anchored
    // to fare_estimate unconditionally, which would have rejected the very fare
    // the customer agreed to whenever they bid above +20%.
    const agreedFare = effectiveFare(ride);

    // Server-side fare recompute: clamp driver-submitted fare to ±20% of the
    // agreed fare, so a driver cannot inflate the total after the fact.
    let fareFinal = agreedFare;
    if (body.fare_final) {
      const maxAllowed = agreedFare * 1.2;
      const minAllowed = agreedFare * 0.8;
      fareFinal = Math.max(minAllowed, Math.min(maxAllowed, body.fare_final));
      fareFinal = Math.round(fareFinal);
    }

    const { data, error } = await supabaseAdmin
      .from("rides")
      .update({
        status: "completed",
        fare_final: fareFinal,
        payment_method: body.payment_method || "cash",
        payment_status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("driver_id", driverId)
      .select()
      .single();

    if (error || !data) {
      return reply.status(500).send({ error: "Failed to complete ride" });
    }

    // Set driver back to online if subscription still active, else offline + increment total_trips
    const { data: driverData } = await supabaseAdmin
      .from("drivers")
      .select("total_trips")
      .eq("id", driverId)
      .single();

    // Check if driver subscription expired while on this trip
    const { data: activeSub } = await supabaseAdmin
      .from("driver_subscriptions")
      .select("id, expires_at")
      .eq("driver_id", driverId)
      .eq("status", "active")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();

    const finalDriverStatus = activeSub ? "online" : "offline";

    await supabaseAdmin
      .from("drivers")
      .update({
        status: finalDriverStatus,
        total_trips: (driverData?.total_trips || 0) + 1,
      })
      .eq("id", driverId);

    // Create earnings ledger entry (0% commission on subscription model — driver keeps 100%)
    const commission = 0;
    const net = fareFinal;
    const { error: earningsError } = await supabaseAdmin.from("earnings").insert({
      ride_id: id,
      driver_id: driverId,
      gross: fareFinal,
      commission,
      net,
      payment_method: body.payment_method || "cash",
    });
    if (earningsError) {
      logger.warn({ rideId: id, err: earningsError.message }, "Earnings ledger insert failed (non-fatal)");
    }

    await supabaseAdmin.from("ride_events").insert({
      ride_id: id,
      type: "completed",
      payload: { fare_final: fareFinal },
    });

    // Broadcast to customer: trip completed
    broadcastRideStatus(id, "completed", { fare_final: fareFinal });
    syncQuickOrder(id, "completed").catch(() => {});
    notifyBusinessWebhook(id, "completed", { fare_final: fareFinal }).catch(() => {});
    
    if (data.customer_id) {
      sendPush([data.customer_id], {
        title: "Trip Completed",
        body: "You have arrived at your destination.",
        data: { ride_id: id, status: "completed" },
      }).catch(() => {});
    }

    return reply.send({ status: "completed", fare_final: fareFinal });
  });

  // POST /rides/:id/pod — Upload Proof of Delivery (Fleet/Quick)
  app.post("/rides/:id/pod", { preHandler: [authGuard, requireRole("driver")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const driverId = request.user!.id;
    const { pod_path } = request.body as any;

    if (!pod_path) {
      return reply.status(400).send({ error: "pod_path is required" });
    }

    // Verify driver owns this ride
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("driver_id, status")
      .eq("id", id)
      .single();

    if (!ride || ride.driver_id !== driverId) {
      return reply.status(403).send({ error: "Not authorized for this ride" });
    }

    const { error } = await supabaseAdmin
      .from("rides")
      .update({ pod_path })
      .eq("id", id);

    if (error) {
      return reply.status(500).send({ error: "Failed to save POD" });
    }

    return reply.send({ success: true });
  });

  // Helper to sync ride state changes to the linked quick_order (if applicable)
  async function syncQuickOrder(rideId: string, status: string) {
    const { data: order } = await supabaseAdmin
      .from("quick_orders")
      .select("id")
      .eq("ride_id", rideId)
      .single();
    
    if (order) {
      let orderStatus = "";
      if (status === "arriving") orderStatus = "rider_arriving_at_store"; // Not heavily used, but informative
      if (status === "in_progress") orderStatus = "out_for_delivery";
      if (status === "completed") orderStatus = "delivered";
      if (status === "cancelled") orderStatus = "delivery_cancelled";

      if (orderStatus) {
        const patch: Record<string, unknown> = { status: orderStatus };
        if (orderStatus === "delivered") patch.delivered_at = new Date().toISOString();
        await supabaseAdmin.from("quick_orders").update(patch).eq("id", order.id);
        broadcastOrderStatus(order.id, orderStatus).catch(() => {});
      }
    }
  }

  // Helper: notify a business's registered webhooks when its fleet job changes state.
  async function notifyBusinessWebhook(rideId: string, status: string, extra: Record<string, unknown> = {}) {
    const { data: ride } = await supabaseAdmin
      .from("rides")
      .select("business_id, service_type")
      .eq("id", rideId)
      .single();

    if (ride?.service_type === "fleet" && ride.business_id) {
      fireWebhook(ride.business_id, `shipment.${status}`, { ride_id: rideId, status, ...extra }).catch(() => {});
    }
  }
}
