import type { FastifyInstance } from "fastify";

/**
 * Fares routes — currently empty because the estimate endpoint
 * has been moved to rides.routes.ts (POST /rides/estimate) where
 * it returns estimates for all vehicle types.
 *
 * This module is kept as a placeholder for future fare-config
 * admin endpoints (e.g. GET /fares/config, PUT /fares/config).
 */
export async function faresRoutes(app: FastifyInstance) {
  // Future: admin fare config endpoints
}
