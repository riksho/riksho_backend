import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { supabaseAnon, supabaseAdmin } from "../config/supabase.js";

export interface AuthUser {
  id: string;
  driverId?: string;
  phone?: string;
  email?: string;
  role?: string;
  roles?: string[];
  isDriver?: boolean;
  isVendor?: boolean;
  isCustomer?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/**
 * Auth guard — extracts and verifies Supabase JWT or DusMint internal JWT.
 * Robustly checks for driver records by both auth UID and normalized phone number,
 * ensuring drivers and vendors are never locked out due to multi-app usage.
 * Attaches the resolved user with multi-role capabilities to `request.user`.
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing or invalid Authorization header. Expected: Bearer <token>",
    });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    let authUserId: string = "";
    let userPhone: string | undefined = undefined;
    let userEmail: string | undefined = undefined;
    let tokenRole: string | undefined = undefined;

    const { data, error } = await supabaseAnon.auth.getUser(token);

    if (error || !data?.user) {
      // Fallback: Check if token is a valid DusMint internal JWT
      try {
        const JWT_SECRET = process.env.JWT_SECRET;
        if (!JWT_SECRET) throw new Error("JWT_SECRET not configured");
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        if (decoded && (decoded.sub || decoded.id)) {
          authUserId = decoded.sub || decoded.id;
          userPhone = decoded.phone;
          tokenRole = decoded.role;
        } else {
          return reply.status(401).send({
            error: "Unauthorized",
            message: "Invalid or expired token",
          });
        }
      } catch {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid or expired token",
        });
      }
    } else {
      authUserId = data.user.id;
      userPhone = data.user.phone || (data.user.user_metadata?.phone as string);
      userEmail = data.user.email;
      tokenRole = data.user.user_metadata?.role;
    }

    const cleanPhone = userPhone ? userPhone.replace(/\D/g, "").slice(-10) : "";

    // 1. Fetch user record from public.users
    const { data: profile } = await supabaseAdmin
      .from("users")
      .select("role, phone, email")
      .eq("id", authUserId)
      .maybeSingle();

    if (!userPhone && profile?.phone) {
      userPhone = profile.phone;
    }
    if (!userEmail && profile?.email) {
      userEmail = profile.email;
    }

    // 2. Check if this user has an existing record in public.drivers (by UID or phone)
    let isDriver = false;
    let driverId = authUserId;

    // Check drivers table by ID
    const { data: driverById } = await supabaseAdmin
      .from("drivers")
      .select("id, phone")
      .eq("id", authUserId)
      .maybeSingle();

    if (driverById) {
      isDriver = true;
      driverId = driverById.id;
    } else if (cleanPhone && cleanPhone.length >= 10) {
      // Fallback: check drivers table by normalized phone
      const { data: driverByPhone } = await supabaseAdmin
        .from("drivers")
        .select("id, phone")
        .ilike("phone", `%${cleanPhone}%`)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (driverByPhone) {
        isDriver = true;
        driverId = driverByPhone.id;
      }
    }

    // 3. Check if user is a vendor in public.vendors
    let isVendor = tokenRole === "vendor" || profile?.role === "vendor";
    if (!isVendor && cleanPhone && cleanPhone.length >= 10) {
      const { data: vendorByPhone } = await supabaseAdmin
        .from("vendors")
        .select("id")
        .or(`auth_user_id.eq.${authUserId},owner_phone.ilike.%${cleanPhone}%`)
        .limit(1)
        .maybeSingle();

      if (vendorByPhone) {
        isVendor = true;
      }
    }

    // 4. Construct comprehensive multi-role set
    const userRoles = new Set<string>();
    userRoles.add("customer"); // Everyone can act as customer
    if (isDriver) userRoles.add("driver");
    if (isVendor) userRoles.add("vendor");
    if (profile?.role) userRoles.add(profile.role);
    if (tokenRole) userRoles.add(tokenRole);
    if (userEmail === "shawsumit6286@gmail.com" || profile?.role === "admin") {
      userRoles.add("admin");
    }

    // 5. Server-authoritative primary role
    let resolvedRole = profile?.role || tokenRole || "customer";
    if (isDriver) {
      // If user is registered as a driver, default to driver unless explicit vendor session
      if (!isVendor || tokenRole !== "vendor") {
        resolvedRole = "driver";
      }
    }
    if (userRoles.has("admin")) {
      resolvedRole = "admin";
    }

    // Auto-sync driver role in users table if previously only customer
    if (isDriver && (!profile?.role || profile.role === "customer")) {
      supabaseAdmin.from("users").update({ role: "driver" }).eq("id", authUserId).then();
    }

    request.user = {
      id: authUserId,
      driverId: isDriver ? driverId : undefined,
      phone: userPhone,
      email: userEmail,
      role: resolvedRole,
      roles: Array.from(userRoles),
      isDriver,
      isVendor,
      isCustomer: true,
    };
  } catch (err) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Token verification failed",
    });
  }
}
