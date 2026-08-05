/**
 * Fare configuration per vehicle type.
 * All values in INR (₹).
 */
export const FARE_CONFIG = {
  bike: {
    base_fare: 20,
    per_km: 8,
    per_min: 1,
    minimum_fare: 30,
    surge_multiplier: 1.0,
  },
  auto: {
    base_fare: 30,
    per_km: 12,
    per_min: 1.5,
    minimum_fare: 50,
    surge_multiplier: 1.0,
  },
  car: {
    base_fare: 50,
    per_km: 15,
    per_min: 2,
    minimum_fare: 80,
    surge_multiplier: 1.0,
  },
  e_rickshaw: {
    base_fare: 25,
    per_km: 10,
    per_min: 1.2,
    minimum_fare: 40,
    surge_multiplier: 1.0,
  },
  tempo: {
    base_fare: 150,
    per_km: 25,
    per_min: 3,
    minimum_fare: 250,
    surge_multiplier: 1.0,
  },
  mini_truck: {
    base_fare: 250,
    per_km: 35,
    per_min: 4,
    minimum_fare: 400,
    surge_multiplier: 1.0,
  },
  truck: {
    base_fare: 500,
    per_km: 50,
    per_min: 5,
    minimum_fare: 800,
    surge_multiplier: 1.0,
  },
} as const;

export type VehicleType = keyof typeof FARE_CONFIG;

export const QUICK_DELIVERY_FEE = 20;

/**
 * Bounds for a customer's offered fare (fix A3), as a ratio of the server's own
 * fare_estimate.
 *
 * Lower bound stops a customer from lowballing to a fare no driver would take
 * (and from underpaying a driver who taps accept without reading). Upper bound
 * caps how far a customer can bid up — 2x covers genuine surge/rain-hour urgency
 * while blocking a crafted request that offers ₹50,000 to game a driver's
 * earnings or launder value through the platform.
 */
export const OFFERED_FARE_MIN_RATIO = 0.8;
export const OFFERED_FARE_MAX_RATIO = 2.0;

/**
 * Clamp a customer-offered fare into the acceptable band around the estimate.
 *
 * Returns a whole rupee amount. Never trust the client value directly — always
 * pass it through here.
 */
export function clampOfferedFare(offeredFare: number, fareEstimate: number): number {
  const min = fareEstimate * OFFERED_FARE_MIN_RATIO;
  const max = fareEstimate * OFFERED_FARE_MAX_RATIO;
  return Math.round(Math.max(min, Math.min(max, offeredFare)));
}

/**
 * The fare a ride should actually settle at, and that drivers should be shown.
 *
 * Centralised because three call sites need the same answer and must not drift:
 * the offer broadcast (what the driver sees), the completion clamp (what the
 * customer pays), and the earnings ledger. When the customer bid, their offer is
 * authoritative; otherwise the server estimate is.
 */
export function effectiveFare(ride: {
  offered_fare?: number | null;
  fare_estimate?: number | null;
}): number {
  return Number(ride.offered_fare ?? ride.fare_estimate ?? 0);
}

/**
 * Calculate fare based on distance and duration.
 */
export function calculateFare(
  vehicleType: VehicleType,
  distanceMeters: number,
  durationSeconds: number,
  surgeFactor?: number,
  cargoWeightKg?: number
): number {
  const config = FARE_CONFIG[vehicleType];
  if (!config) throw new Error(`Unknown vehicle type: ${vehicleType}`);

  const distanceKm = distanceMeters / 1000;
  const durationMin = durationSeconds / 60;
  const surge = surgeFactor || config.surge_multiplier;

  let rawFare =
    (config.base_fare + config.per_km * distanceKm + config.per_min * durationMin) * surge;

  // Apply cargo weight surcharge for fleet
  if (cargoWeightKg && cargoWeightKg > 100) {
    // Surcharge of ₹2 per kg over 100kg
    rawFare += (cargoWeightKg - 100) * 2;
  }

  return Math.max(Math.round(rawFare), config.minimum_fare);
}
