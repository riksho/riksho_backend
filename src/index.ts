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

const app = Fastify({
  logger: false, // We use our own pino logger
  bodyLimit: 1_048_576, // 1 MB — prevents payload abuse
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

// Rate limiting
await app.register(rateLimit, {
  max: 100,           // 100 requests per minute per IP (global)
  timeWindow: "1 minute",
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
app.get("/health", async () => ({
  status: "ok",
  service: "riksho-backend",
  version: "1.0.0",
  timestamp: new Date().toISOString(),
}));

// --- Register route modules ---
await app.register(authRoutes);
await app.register(driversRoutes);
await app.register(faresRoutes);
await app.register(ridesRoutes);
await app.register(ratingsRoutes);
await app.register(pushRoutes);

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
