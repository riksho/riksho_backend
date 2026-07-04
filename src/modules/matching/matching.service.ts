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
  rideId: string
): Promise<void> {
  // Approximate bounding box (1 degree lat ≈ 111km)
  const latDelta = SEARCH_RADIUS_KM / 111;
  const lngDelta = SEARCH_RADIUS_KM / (111 * Math.cos((lat * Math.PI) / 180));

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
    .limit(MAX_DRIVERS * 2); // Fetch extra, filter by status next

  if (error || !nearbyLocations?.length) {
    logger.warn({ rideId }, "No nearby drivers found");
    return;
  }

  // Filter to only online drivers with matching vehicle type
  const driverIds = nearbyLocations.map((loc) => loc.driver_id);

  const { data: onlineDrivers } = await supabaseAdmin
    .from("drivers")
    .select("id, name")
    .in("id", driverIds)
    .eq("status", "online")
    .limit(MAX_DRIVERS);

  if (!onlineDrivers?.length) {
    logger.warn({ rideId }, "No online drivers nearby");
    return;
  }

  // Fetch ride details to include in the offer
  const { data: rideData } = await supabaseAdmin
    .from("rides")
    .select("origin_address, dest_address, fare_estimate, distance_m")
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
      fare_estimate: rideData?.fare_estimate,
      distance_km: rideData?.distance_m ? +(rideData.distance_m / 1000).toFixed(1) : undefined,
    });
  }

  logger.info({ rideId, driverCount: onlineDrivers.length }, "Sent ride offers to nearby drivers");
}
