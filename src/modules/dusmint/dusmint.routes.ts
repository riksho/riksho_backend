import type { FastifyInstance } from "fastify";
import { dusmintAuthRoutes } from "./dusmint.auth.routes.js";
import { dusmintClustersRoutes } from "./dusmint.clusters.routes.js";
import { dusmintCatalogRoutes } from "./dusmint.catalog.routes.js";
import { dusmintOrdersRoutes } from "./dusmint.orders.routes.js";
import { dusmintClaimsRoutes } from "./dusmint.claims.routes.js";
import { dusmintVendorRoutes } from "./dusmint.vendor.routes.js";

/**
 * DusMint Hyperlocal Grocery Subsystem
 * Mounted under /api/v1 prefix
 */
export async function dusmintRoutes(app: FastifyInstance) {
  await app.register(
    async (v1) => {
      // Health check for DusMint API subsystem
      v1.get("/health", async () => ({
        status: "ok",
        service: "dusmint-api",
        timestamp: new Date().toISOString(),
      }));

      // Register all DusMint domain routes
      await v1.register(dusmintAuthRoutes);
      await v1.register(dusmintClustersRoutes);
      await v1.register(dusmintCatalogRoutes);
      await v1.register(dusmintOrdersRoutes);
      await v1.register(dusmintClaimsRoutes);
      await v1.register(dusmintVendorRoutes);
    },
    { prefix: "/api/v1" }
  );
}
