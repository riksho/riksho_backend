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
