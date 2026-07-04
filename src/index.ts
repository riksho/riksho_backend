import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
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
});

// --- Plugins ---
await app.register(cors, {
  origin: true, // Allow all origins in dev; lock down in production
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

await app.register(helmet, {
  contentSecurityPolicy: false, // Not needed for an API server
});

// --- Global error handler ---
app.setErrorHandler((error, request, reply) => {
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

// --- Start ---
try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`🚀 Riksho Backend running on http://localhost:${env.PORT}`);
  logger.info(`   Environment: ${env.NODE_ENV}`);
  logger.info(`   Supabase: ${env.SUPABASE_URL}`);
  logger.info(`   Health: http://localhost:${env.PORT}/health`);
} catch (err) {
  logger.error(err, "Failed to start server");
  process.exit(1);
}
