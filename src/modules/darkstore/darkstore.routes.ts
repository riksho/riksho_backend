import { FastifyInstance } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";
import { z } from "zod";

const NearestDarkstoreSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

export async function darkstoreRoutes(app: FastifyInstance) {
  // GET /darkstores/nearest?lat=...&lng=...
  // Finds the nearest active darkstore that serves the given coordinates.
  // In a real production app we'd use PostGIS (ST_Distance), but for MVP we use basic math or just fetch all and filter in JS if small.
  // We'll fetch all active stores and calculate distance in JS for simplicity of this prototype.
  app.get("/darkstores/nearest", async (request, reply) => {
    const query = NearestDarkstoreSchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "Missing or invalid lat/lng" });
    }

    const { lat, lng } = query.data;

    const { data: stores, error } = await supabaseAdmin
      .from("darkstores")
      .select("*")
      .eq("is_active", true);

    if (error || !stores || stores.length === 0) {
      return reply.status(404).send({ error: "No active darkstores found" });
    }

    // Haversine formula for distance
    let nearestStore = null;
    let minDistance = Infinity;

    for (const store of stores) {
      const distance = getDistanceFromLatLonInKm(lat, lng, store.lat, store.lng);
      if (distance <= store.service_radius_km && distance < minDistance) {
        minDistance = distance;
        nearestStore = store;
      }
    }

    if (!nearestStore) {
      return reply.status(404).send({ error: "No darkstore services this location" });
    }

    return reply.send({ store: nearestStore, distance_km: minDistance });
  });
}

function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1); 
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  const d = R * c; // Distance in km
  return d;
}

function deg2rad(deg: number) {
  return deg * (Math.PI/180);
}
