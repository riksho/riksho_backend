import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";
import { broadcastRideOffer } from "./broadcast.service.js";

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
export async function findNearbyDrivers(
  lat: number,
  lng: number,
  vehicleType: string,
  rideId: string,
  serviceType: "move" | "fleet" | "quick" = "move",
  cargoWeightKg?: number
): Promise<void> {
  // Approximate bounding box (1 degree lat ≈ 111km)
  // Expand radius for fleet since partners are sparse
  const searchRadiusKm = serviceType === "fleet" ? 15 : (serviceType === "quick" ? 3 : SEARCH_RADIUS_KM);
  const latDelta = searchRadiusKm / 111;
  const lngDelta = searchRadiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  // Filter stale locations: only drivers who updated in the last 2 minutes
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data: nearbyLocations, error } = await supabaseAdmin
    .from("driver_locations")
    .select("driver_id, lat, lng")
    .gte("lat", lat - latDelta)
    .lte("lat", lat + latDelta)
    .gte("lng", lng - lngDelta)
    .lte("lng", lng + lngDelta)
    .gte("updated_at", staleThreshold)
    .limit(MAX_DRIVERS * 4); // Fetch extra for extended filtering

  if (error || !nearbyLocations?.length) {
    logger.warn({ rideId }, "No nearby drivers found");
    return;
  }

  // Filter to only online drivers with matching vehicle type and capacity
  const driverIds = nearbyLocations.map((loc) => loc.driver_id);
  
  let query = supabaseAdmin
    .from("drivers")
    .select("id, name, partner_type, vehicles!inner(type, capacity_kg)")
    .in("id", driverIds)
    .eq("status", "online")
    .eq("is_verified", true);

  if (serviceType === "fleet") {
    // Fleet: match the requested truck class + enough payload capacity.
    query = query.eq("partner_type", "fleet").eq("vehicles.type", vehicleType);
    if (cargoWeightKg) {
      query = query.gte("vehicles.capacity_kg", cargoWeightKg);
    }
  } else if (serviceType === "quick") {
    // Quick: any verified quick_rider nearby. We deliberately do NOT filter on
    // vehicles.type — a rider's registered vehicle (auto/bike) is irrelevant to
    // carrying a small delivery bag, and enforcing it caused zero matches (M4).
    query = query.eq("partner_type", "quick_rider");
  } else {
    // Move (cab/bike): match the requested vehicle type.
    query = query.eq("partner_type", "cab_bike").eq("vehicles.type", vehicleType);
  }

  const { data: onlineDrivers } = await query.limit(MAX_DRIVERS);

  if (!onlineDrivers?.length) {
    logger.warn({ rideId }, "No online drivers nearby matching criteria");
    return;
  }

    // Fetch ride details to include in the offer
  const { data: rideData } = await supabaseAdmin
    .from("rides")
    .select("origin_address, dest_address, fare_estimate, distance_m, service_type, cargo_weight_kg")
    .eq("id", rideId)
    .single();

  // Broadcast ride offer to each driver via REST broadcast (no subscribe needed)
  for (const driver of onlineDrivers) {
    await broadcastRideOffer(driver.id, {
      ride_id: rideId,
      origin_lat: lat,
      origin_lng: lng,
      origin_address: rideData?.origin_address,
      dest_address: rideData?.dest_address,
      vehicle_type: vehicleType,
      service_type: rideData?.service_type,
      cargo_weight_kg: rideData?.cargo_weight_kg,
      fare_estimate: rideData?.fare_estimate,
      distance_km: rideData?.distance_m ? +(rideData.distance_m / 1000).toFixed(1) : undefined,
    });
  }

  logger.info({ rideId, driverCount: onlineDrivers.length }, "Sent ride offers to nearby drivers");
}
