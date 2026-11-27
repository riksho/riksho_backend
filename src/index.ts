import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { logger } from "./common/logger.js";
import { AppError } from "./common/errors.js";

// Route modules
import { authRoutes } from "./modules/auth/auth.routes.js";
import { driversRoutes } from "./modules/drivers/drivers.routes.js";
import { faresRoutes } from "./modules/fares/fares.routes.js";
import { ridesRoutes } from "./modules/rides/rides.routes.js";
import { ratingsRoutes } from "./modules/ratings/ratings.routes.js";
import { pushRoutes } from "./modules/notifications/push.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import businessRoutes from "./modules/business/business.routes.js";
import { shipmentsRoutes } from "./modules/api-gateway/shipments.routes.js";
import { fleetRoutes } from "./modules/fleet/fleet.routes.js";
import { startScheduler } from "./modules/fleet/scheduler.js";
import { catalogRoutes } from "./modules/catalog/catalog.routes.js";
import { darkstoreRoutes } from "./modules/darkstore/darkstore.routes.js";
import { ordersRoutes } from "./modules/orders/orders.routes.js";
import { settlementRoutes } from "./modules/settlement/settlement.routes.js";
import { fcmRoutes } from "./modules/notifications/fcm.routes.js";
import { promotersRoutes } from "./modules/promoters/promoters.routes.js";
import { subscriptionsRoutes } from "./modules/subscriptions/subscriptions.routes.js";
import { promosRoutes } from "./modules/promos/promos.routes.js";
import { dusmintRoutes } from "./modules/dusmint/dusmint.routes.js";

// Firebase init (side-effect: initialises firebase-admin)
import "./config/firebase.js";

const app = Fastify({
  logger: false, // We use our own pino logger
  bodyLimit: 1_048_576, // 1 MB — prevents payload abuse
});

// Safe JSON parser: handles empty bodies gracefully without throwing FST_ERR_CTP_EMPTY_JSON_BODY
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  try {
    if (!body || (typeof body === "string" && body.trim() === "")) {
      done(null, {});
      return;
    }
    const json = JSON.parse(body as string);
    done(null, json);
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

// --- Plugins ---

// CORS: lock down in production, allow all in dev
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : true; // true = reflect any origin in dev

await app.register(cors, {
  origin: corsOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

await app.register(helmet, {
  contentSecurityPolicy: false, // Not needed for an API server
});

// Rate limiting.
//
// Keyed on the authenticated user id where available, falling back to IP for
// unauthenticated routes. Per-IP alone is wrong for this app (fix A4): Indian
// mobile carriers put many subscribers behind the same NAT address, and the
// background location service now posts ~12x/min per on-trip driver. A handful of
// drivers on the same carrier would exhaust a shared 100/min budget and start
// getting 429s on ride accepts — the worst possible request to drop.
await app.register(rateLimit, {
  max: 300,
  timeWindow: "1 minute",
  keyGenerator: (request) => request.user?.id ?? request.ip,
});

// --- Global error handler ---
app.setErrorHandler((error, request, reply) => {
  // Zod validation errors → 400
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: "VALIDATION_ERROR",
      message: "Invalid request data",
      issues: error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      })),
    });
  }

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }

  logger.error(error, "Unhandled error");
  return reply.status(500).send({
    error: "INTERNAL_SERVER_ERROR",
    message: env.NODE_ENV === "production" ? "Something went wrong" : (error as Error).message,
  });
});

// --- Health check ---
app.route({
  method: ["GET", "HEAD"],
  url: "/health",
  handler: async (_request, reply) => {
    return reply.status(200).send({ status: "ok" });
  },
});

app.route({
  method: ["GET", "HEAD"],
  url: "/",
  handler: async (_request, reply) => {
    return reply.status(200).send("OK");
  },
});

// --- App Version & Remote Force Update Gate ---
app.get("/app/version", async (request, reply) => {
  const { app: targetApp } = (request.query || {}) as { app?: string };
  const isPartner =
    targetApp === "partner" ||
    targetApp === "riksho_partner" ||
    targetApp === "driver" ||
    targetApp === "buddy" ||
    targetApp === "com.riksho.buddy";

  if (isPartner) {
    return reply.status(200).send({
      app: "partner",
      package_name: "com.riksho.buddy",
      min_version_code: Number(process.env.PARTNER_MIN_VERSION_CODE || 10),
      latest_version_code: Number(process.env.PARTNER_LATEST_VERSION_CODE || 11),
      force_update: process.env.PARTNER_FORCE_UPDATE === "true",
      title: "Update Required",
      message: "A new version of Riksho Buddy is available with important improvements. Please update from Google Play Store to continue receiving rides.",
      store_url: "market://details?id=com.riksho.buddy",
      web_url: "https://play.google.com/store/apps/details?id=com.riksho.buddy",
    });
  }

  // Customer app default
  return reply.status(200).send({
    app: "customer",
    package_name: "com.riksho.customer",
    min_version_code: Number(process.env.CUSTOMER_MIN_VERSION_CODE || 8),
    latest_version_code: Number(process.env.CUSTOMER_LATEST_VERSION_CODE || 9),
    force_update: process.env.CUSTOMER_FORCE_UPDATE === "true",
    title: "Update Required",
    message: "A new version of Riksho is available with important improvements. Please update from Google Play Store to continue using Riksho.",
    store_url: "market://details?id=com.riksho.customer",
    web_url: "https://play.google.com/store/apps/details?id=com.riksho.customer",
  });
});

// --- Register route modules ---
await app.register(authRoutes);
await app.register(driversRoutes);
await app.register(faresRoutes);
await app.register(ridesRoutes);
await app.register(ratingsRoutes);
await app.register(pushRoutes);
await app.register(adminRoutes);
await app.register(businessRoutes);
await app.register(shipmentsRoutes);
await app.register(fleetRoutes);
await app.register(catalogRoutes);
await app.register(darkstoreRoutes);
await app.register(ordersRoutes);
await app.register(settlementRoutes);
await app.register(fcmRoutes);
await app.register(promotersRoutes);
await app.register(subscriptionsRoutes);
await app.register(promosRoutes);
await app.register(dusmintRoutes);

// --- Start Background Services ---
startScheduler();

// --- Graceful shutdown ---
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    await app.close();
    logger.info("Server closed.");
    process.exit(0);
  } catch (err) {
    logger.error(err, "Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Start ---
try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`🚀 Riksho Backend running on http://localhost:${env.PORT}`);
  logger.info(`   Environment: ${env.NODE_ENV}`);
  logger.info(`   Supabase: ${env.SUPABASE_URL}`);
  logger.info(`   Health: http://localhost:${env.PORT}/health`);
  logger.info(`   CORS origins: ${typeof corsOrigins === "boolean" ? "all (dev)" : corsOrigins.join(", ")}`);
  logger.info(`   Rate limit: 100 req/min per IP`);
} catch (err) {
  logger.error(err, "Failed to start server");
  process.exit(1);
}
