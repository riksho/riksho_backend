import { z } from "zod";

// ---- Rides ----

export const RideRequestSchema = z.object({
  origin_lat: z.number().min(-90).max(90),
  origin_lng: z.number().min(-180).max(180),
  origin_address: z.string().min(1),
  dest_lat: z.number().min(-90).max(90),
  dest_lng: z.number().min(-180).max(180),
  dest_address: z.string().min(1),
  vehicle_type: z.enum(["bike", "auto", "car", "tempo", "mini_truck", "truck"]),
  service_type: z.enum(["move", "fleet", "quick"]).optional().default("move"),
  cargo_weight_kg: z.number().min(1).optional(),
});

export const RideEstimateSchema = z.object({
  origin_lat: z.number().min(-90).max(90),
  origin_lng: z.number().min(-180).max(180),
  dest_lat: z.number().min(-90).max(90),
  dest_lng: z.number().min(-180).max(180),
  vehicle_type: z.enum(["bike", "auto", "car"]),
});

export const RideCancelSchema = z.object({
  reason: z.string().optional(),
});

export const RideCompleteSchema = z.object({
  fare_final: z.number().positive().optional(),
  payment_method: z.enum(["cash", "online"]).optional(),
});

// ---- Drivers ----

export const DriverLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const DriverRegisterSchema = z.object({
  name: z.string().min(1),
  license_no: z.string().min(1),
  vehicle_type: z.enum(["bike", "auto", "car", "tempo", "mini_truck", "truck"]),
  plate: z.string().min(1),
  model: z.string().min(1),
  seats: z.number().int().min(1).max(8).optional(),
  partner_type: z.enum(["cab_bike", "fleet", "quick_rider"]).optional().default("cab_bike"),
  capacity_kg: z.number().int().optional(),
});

// ---- Business ----

export const BusinessRegisterSchema = z.object({
  name: z.string().min(1),
  gstin: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  tier: z.string().optional(),
});

// ---- Ratings ----

export const RatingSchema = z.object({
  ride_id: z.string().uuid(),
  stars: z.number().int().min(1).max(5),
  comment: z.string().optional(),
});

// ---- Auth / Profile ----

export const ProfileUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  avatar_url: z.string().url().optional(),
});

// ---- Push ----

export const PushRegisterSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["android", "ios", "web"]).optional(),
});
