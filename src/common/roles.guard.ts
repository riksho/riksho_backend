import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Role-based access control guard.
 * Usage: { preHandler: [authGuard, requireRole("driver")] }
 */
export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userRole = req.user?.role ?? "customer";
    
    // Role escalation: drivers and admins inherit customer privileges
    const effectiveRoles = [userRole];
    if (userRole === "driver" || userRole === "admin" || userRole === "business_owner") {
      effectiveRoles.push("customer");
    }
    
    const hasAccess = roles.some(role => effectiveRoles.includes(role));

    if (!hasAccess) {
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: `Insufficient role. Required: ${roles.join(" or ")}`,
      });
    }
  };
}
