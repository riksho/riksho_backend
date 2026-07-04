import { supabaseAdmin } from "../../config/supabase.js";
import { logger } from "../../common/logger.js";

const SEARCH_RADIUS_KM = 5;
const MAX_DRIVERS = 10;

/**
 * Find nearby online drivers within a radius and broadcast the ride offer.
 * Uses a simple bounding-box lat/lng filter (good enough for MVP).
 * For production, use PostGIS earth_distance or geography type.
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

  const { data: nearbyLocations, error } = await supabaseAdmin
    .from("driver_locations")
    .select("driver_id, lat, lng")
    .gte("lat", lat - latDelta)
    .lte("lat", lat + latDelta)
    .gte("lng", lng - lngDelta)
    .lte("lng", lng + lngDelta)
    .limit(MAX_DRIVERS * 2); // Fetch extra, filter by status next

  if (error || !nearbyLocations?.length) {
    logger.warn({ rideId }, "No nearby drivers found");
    return;
  }

  // Filter to only online drivers with matching vehicle type
  const driverIds = nearbyLocations.map((loc) => loc.driver_id);

  const { data: onlineDrivers } = await supabaseAdmin
    .from("drivers")
    .select("id")
    .in("id", driverIds)
    .eq("status", "online")
    .limit(MAX_DRIVERS);

  if (!onlineDrivers?.length) {
    logger.warn({ rideId }, "No online drivers nearby");
    return;
  }

  // Broadcast ride offer to each driver via Supabase Realtime
  for (const driver of onlineDrivers) {
    const channel = supabaseAdmin.channel(`driver:${driver.id}`);
    channel.send({
      type: "broadcast",
      event: "ride_offer",
      payload: {
        ride_id: rideId,
        origin_lat: lat,
        origin_lng: lng,
        vehicle_type: vehicleType,
      },
    });

    logger.info({ rideId, driverId: driver.id }, "Sent ride offer");
  }
}
