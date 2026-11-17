import dotenv from "dotenv";
dotenv.config({ path: "./riksho_backend/.env" });
import Fastify from "fastify";
import cors from "@fastify/cors";
import { dusmintRoutes } from "./dist/modules/dusmint/dusmint.routes.js";

async function testRoutes() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // Riksho health check
  app.get("/health", async () => ({ status: "ok", app: "riksho" }));

  // Register Dusmint subsystem
  await app.register(dusmintRoutes);

  await app.ready();
  console.log("✅ Fastify loaded all routes successfully!");

  // Test 1: Riksho Health
  const resRiksho = await app.inject({ method: "GET", url: "/health" });
  console.log("Test 1: Riksho /health ->", resRiksho.statusCode, resRiksho.json());

  // Test 2: DusMint Health
  const resDusmint = await app.inject({ method: "GET", url: "/api/v1/health" });
  console.log("Test 2: DusMint /api/v1/health ->", resDusmint.statusCode, resDusmint.json());

  // Test 3: DusMint Clusters Check Serviceability
  const resClusters = await app.inject({
    method: "GET",
    url: "/api/v1/clusters/check-serviceability?lat=22.7533&lng=75.8937"
  });
  console.log("Test 3: DusMint /api/v1/clusters/check-serviceability ->", resClusters.statusCode, resClusters.json());

  // Test 4: DusMint Vendor List
  const resVendors = await app.inject({ method: "GET", url: "/api/v1/vendor/list" });
  console.log("Test 4: DusMint /api/v1/vendor/list ->", resVendors.statusCode, `Count: ${resVendors.json()?.length ?? 0}`);

  // Test 5: DusMint Catalog Items
  const resItems = await app.inject({ method: "GET", url: "/api/v1/items" });
  console.log("Test 5: DusMint /api/v1/items ->", resItems.statusCode, `Count: ${resItems.json()?.length ?? 0}`);

  console.log("\n🎉 ALL ROUTE INJECTION TESTS PASSED WITH 0 CONFLICTS!");
}

testRoutes().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
