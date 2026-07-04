import type { FastifyInstance } from "fastify";
import { authGuard } from "../../common/auth.guard.js";
import { calculateFare, type VehicleType } from "./fares.config.js";

export async function faresRoutes(app: FastifyInstance) {
  // POST /rides/estimate — Get fare estimate
  app.post("/rides/estimate", { preHandler: [authGuard] }, async (request, reply) => {
    const body = request.body as {
      origin_lat: number;
      origin_lng: number;
      dest_lat: number;
      dest_lng: number;
      vehicle_type: VehicleType;
    };

    if (!body.origin_lat || !body.origin_lng || !body.dest_lat || !body.dest_lng || !body.vehicle_type) {
      return reply.status(400).send({ error: "origin_lat, origin_lng, dest_lat, dest_lng, vehicle_type are required" });
    }

    try {
      // Calculate distance using OSRM (free, no API key needed)
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${body.origin_lng},${body.origin_lat};${body.dest_lng},${body.dest_lat}?overview=false`;
      const response = await fetch(osrmUrl);
      const data = await response.json() as { routes?: Array<{ distance: number; duration: number }> };

      if (!data.routes || data.routes.length === 0) {
        return reply.status(400).send({ error: "Could not calculate route" });
      }

      const route = data.routes[0];
      const distanceM = route.distance;
      const durationS = route.duration;
      const fare = calculateFare(body.vehicle_type, distanceM, durationS);

      return reply.send({
        distance_m: Math.round(distanceM),
        distance_km: +(distanceM / 1000).toFixed(1),
        duration_s: Math.round(durationS),
        duration_min: Math.round(durationS / 60),
        fare_estimate: fare,
        vehicle_type: body.vehicle_type,
        currency: "INR",
      });
    } catch (err) {
      return reply.status(500).send({ error: "Failed to calculate route estimate" });
    }
  });
}
