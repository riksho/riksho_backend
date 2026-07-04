import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Role-based access control guard.
 * Usage: { preHandler: [authGuard, requireRole("driver")] }
 */
export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userRole = req.user?.role ?? "customer";
    if (!roles.includes(userRole)) {
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: `Insufficient role. Required: ${roles.join(" or ")}`,
      });
    }
  };
}
