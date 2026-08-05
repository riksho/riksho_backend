import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { broadcastRideOffer } from "./broadcast.service.js";
import { sendRideOfferPush } from "../notifications/push.service.js";
import { effectiveFare } from "../fares/fares.config.js";

const SEARCH_RADIUS_KM = 5;
const MAX_DRIVERS = 10;
const STALE_MINUTES = 2;

/**
 * Find nearby online drivers within a radius and broadcast the ride offer.
 * Uses a simple bounding-box lat/lng filter (good enough for MVP).
 * For production, use PostGIS nearby_drivers() RPC.
 *
 * Fixed issues:
 * - Uses REST broadcast (not channel.send without subscribe)
 * - Filters stale locations (updated_at > 2 min ago)
 * - Includes ride details in offer payload
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function findNearbyDrivers(
  lat: number,
  lng: number,
  vehicleType: string,
  rideId: string,
  serviceType: "move" | "fleet" | "quick" = "move",
  cargoWeightKg?: number
): Promise<void> {
  // Fetch ride details once
  const { data: rideData } = await supabaseAdmin
    .from("rides")
    .select("origin_address, dest_address, fare_estimate, offered_fare, distance_m, service_type, cargo_weight_kg")
    .eq("id", rideId)
    .single();

  const offerPayload = {
    ride_id: rideId,
    origin_lat: lat,
    origin_lng: lng,
    origin_address: rideData?.origin_address,
    dest_address: rideData?.dest_address,
    vehicle_type: vehicleType,
    service_type: rideData?.service_type,
    cargo_weight_kg: rideData?.cargo_weight_kg,
    fare_estimate: rideData ? effectiveFare(rideData) : undefined,
    base_estimate: rideData?.fare_estimate,
    is_boosted: Boolean(
      rideData?.offered_fare && Number(rideData.offered_fare) > Number(rideData.fare_estimate)
    ),
    distance_km: rideData?.distance_m ? +(rideData.distance_m / 1000).toFixed(1) : undefined,
  };

  const radii = [3000, 5000, 8000]; // 3km, 5km, 8km
  const delays = [0, 15000, 15000]; // 0s, 15s, 15s

  for (let i = 0; i < radii.length; i++) {
    if (delays[i] > 0) {
      await delay(delays[i]);
    }

    // Check if ride is still in requested state
    const { data: rideCheck } = await supabaseAdmin
      .from("rides")
      .select("status, driver_id")
      .eq("id", rideId)
      .single();

    if (!rideCheck || rideCheck.status !== "requested" || rideCheck.driver_id) {
      logger.info({ rideId }, "Ride no longer requested, aborting matching wave");
      return;
    }

    const radiusMeters = serviceType === "fleet" ? radii[i] * 3 : radii[i];

    // Fetch declined driver IDs
    const { data: declines } = await supabaseAdmin
      .from("ride_declines")
      .select("driver_id")
      .eq("ride_id", rideId);
    
    const excludedDriverIds = declines ? declines.map(d => d.driver_id) : [];

    // Use PostGIS nearby_drivers RPC
    const { data: nearbyLocations, error } = await supabaseAdmin.rpc("nearby_drivers", {
      p_lat: lat,
      p_lng: lng,
      p_radius_m: radiusMeters,
      p_vehicle_type: serviceType === "quick" ? "" : vehicleType,
      p_excluded_driver_ids: excludedDriverIds
    });

    if (error || !nearbyLocations?.length) {
      logger.warn({ rideId, radiusMeters, wave: i + 1 }, "No nearby drivers found in this wave");
      continue; // Try next wave
    }

    const driverIds = nearbyLocations.map((loc: any) => loc.driver_id);
    
    let query = supabaseAdmin
      .from("drivers")
      .select("id, name, partner_type, vehicles!inner(type, capacity_kg)")
      .in("id", driverIds)
      .eq("status", "online")
      .eq("is_verified", true);

    if (serviceType === "fleet") {
      query = query.eq("partner_type", "fleet").eq("vehicles.type", vehicleType);
      if (cargoWeightKg) {
        query = query.gte("vehicles.capacity_kg", cargoWeightKg);
      }
    } else if (serviceType === "quick") {
      query = query.eq("partner_type", "quick_rider");
    } else {
      query = query.eq("partner_type", "cab_bike").eq("vehicles.type", vehicleType);
    }

    const { data: onlineDrivers } = await query;

    if (!onlineDrivers?.length) {
      logger.warn({ rideId, wave: i + 1 }, "No online drivers matching criteria in this wave");
      continue;
    }

    await Promise.allSettled(
      onlineDrivers.map((driver) => broadcastRideOffer(driver.id, offerPayload))
    );

    await sendRideOfferPush(
      onlineDrivers.map((d) => d.id),
      offerPayload
    );

    logger.info({ rideId, driverCount: onlineDrivers.length, radiusMeters, wave: i + 1 }, "Sent ride offers to drivers");
  }
}
