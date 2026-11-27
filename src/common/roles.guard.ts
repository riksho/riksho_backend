import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Role-based access control guard.
 * Supports multi-role users (e.g. driver + vendor + customer) seamlessly.
 * Usage: { preHandler: [authGuard, requireRole("driver")] }
 */
export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userRole = req.user?.role ?? "customer";
    const userRoles = req.user?.roles || [userRole];
    
    // Build comprehensive set of effective roles with escalation & inheritance
    const effectiveRoles = new Set<string>(userRoles);
    effectiveRoles.add(userRole);

    // If request user is an identified driver in the drivers table
    if (req.user?.isDriver) {
      effectiveRoles.add("driver");
    }

    // If request user is a registered vendor
    if (req.user?.isVendor) {
      effectiveRoles.add("vendor");
    }

    // Master admin privileges
    if (
      req.user?.email === "shawsumit6286@gmail.com" ||
      effectiveRoles.has("admin") ||
      userRole === "admin"
    ) {
      effectiveRoles.add("admin");
      effectiveRoles.add("driver");
      effectiveRoles.add("vendor");
      effectiveRoles.add("customer");
    }
    
    // Drivers, admins, and business owners inherit customer privileges
    if (
      effectiveRoles.has("driver") ||
      effectiveRoles.has("admin") ||
      effectiveRoles.has("business_owner")
    ) {
      effectiveRoles.add("customer");
    }
    
    const hasAccess = roles.some((role) => effectiveRoles.has(role));

    if (!hasAccess) {
      return reply.status(403).send({
        error: "FORBIDDEN",
        message: `Insufficient role. Required: ${roles.join(" or ")}`,
      });
    }
  };
}
