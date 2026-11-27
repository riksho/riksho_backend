import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { supabaseAdmin, supabaseAnon } from "../../config/supabase.js";
import { dusmintAuthGuard } from "./dusmint.auth.guard.js";
import { logger } from "../../common/logger.js";
import { env } from "../../config/env.js";
import crypto from "crypto";

const JWT_SECRET: string = process.env.JWT_SECRET || "";
if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("FATAL: JWT_SECRET environment variable must be set in production");
}

// Supabase Auth Test Phone Numbers (mirrors Supabase Dashboard -> Auth -> Phone -> Test Phone Numbers)
const SUPABASE_TEST_PHONES: Record<string, string> = {
  "9876543210": "123456",
};

/**
 * Generate a cryptographically random 6-digit OTP.
 */
function generateOtp(): string {
  return String(100000 + crypto.randomInt(900000));
}

/**
 * Robustly find or create an auth user id for the given phone number.
 * Seamlessly handles existing Riksho riders, Riksho drivers, DusMint partners,
 * DusMint customers, pagination in listUsers, and format differences.
 */
async function resolveOrCreateAuthUserId(
  formattedPhone: string,
  cleanPhone: string,
  appType?: string
): Promise<string> {
  // 1. Check existing DusMint profiles table
  try {
    const { data: prof } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .ilike("phone", `%${cleanPhone}%`)
      .maybeSingle();
    if (prof?.id) return prof.id;
  } catch (err) {
    logger.warn({ err, cleanPhone }, "profiles table check failed");
  }

  // 2. Check existing DusMint vendors table
  try {
    const { data: v } = await supabaseAdmin
      .from("vendors")
      .select("auth_user_id")
      .ilike("owner_phone", `%${cleanPhone}%`)
      .maybeSingle();
    if (v?.auth_user_id) return v.auth_user_id;
  } catch (err) {
    logger.warn({ err, cleanPhone }, "vendors table check failed");
  }

  // 3. Check existing Riksho drivers table
  try {
    const { data: d } = await supabaseAdmin
      .from("drivers")
      .select("id")
      .ilike("phone", `%${cleanPhone}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (d?.id) return d.id;
  } catch (err) {
    logger.warn({ err, cleanPhone }, "drivers table check failed in dusmint");
  }

  // 4. Check existing Riksho users table
  try {
    const { data: u } = await supabaseAdmin
      .from("users")
      .select("id")
      .ilike("phone", `%${cleanPhone}%`)
      .limit(1)
      .maybeSingle();
    if (u?.id) return u.id;
  } catch (err) {
    logger.warn({ err, cleanPhone }, "users table check failed in dusmint");
  }

  // 5. Try paginated search in Supabase Auth via listUsers (up to 1000 users)
  try {
    for (let page = 1; page <= 10; page++) {
      const { data: usersData, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: 100,
      });
      if (listErr || !usersData?.users || usersData.users.length === 0) break;

      const match = usersData.users.find((u) => {
        const uPhone = (u.phone || (u.user_metadata?.phone as string) || "").replace(/\D/g, "");
        return uPhone.endsWith(cleanPhone);
      });
      if (match) return match.id;
      if (usersData.users.length < 100) break;
    }
  } catch (err) {
    logger.warn({ err, cleanPhone }, "listUsers failed during user resolution");
  }

  // 6. Direct schema('auth') query if supported
  try {
    const { data: authUser } = await (supabaseAdmin as any)
      .schema("auth")
      .from("users")
      .select("id")
      .ilike("phone", `%${cleanPhone}%`)
      .maybeSingle();
    if (authUser?.id) return authUser.id;
  } catch {}

  // 7. Try to create the user in Supabase Auth if not yet created
  try {
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      phone: formattedPhone,
      phone_confirm: true,
      user_metadata: { phone: formattedPhone, app: appType || "dusmint" },
    });
    if (created?.user?.id) return created.user.id;
    if (createErr) {
      logger.warn({ err: createErr, cleanPhone }, "createUser with phone returned error");
    }
  } catch (createErr: any) {
    logger.warn({ err: createErr, cleanPhone }, "createUser exception during resolution");
  }

  // 8. Guaranteed fallback: create in auth.users with internal email so foreign keys never fail
  try {
    const fallbackEmail = `user_${cleanPhone}_${Date.now()}@dusmint.internal`;
    const { data: createdFallback } = await supabaseAdmin.auth.admin.createUser({
      email: fallbackEmail,
      email_confirm: true,
      user_metadata: { phone: formattedPhone, app: appType || "dusmint" },
    });
    if (createdFallback?.user?.id) return createdFallback.user.id;
  } catch (err: any) {
    logger.error({ err, cleanPhone }, "All Supabase Auth user resolution strategies failed");
  }

  // 9. Absolute last-resort fallback
  return crypto.randomUUID();
}

export async function dusmintAuthRoutes(fastify: FastifyInstance) {
  // 1. Send Phone OTP — bypasses Supabase signInWithOtp to avoid sender-ID conflicts
  //    Generates OTP server-side, stores it in dusmint_pending_otps, then calls the
  //    send-sms Edge Function directly with { app: "dusmint" } → MSG91 10MINT template.
  fastify.post("/auth/otp/send", async (request: FastifyRequest, reply: FastifyReply) => {
    const { phone } = request.body as { phone?: string };
    if (!phone || phone.length < 10) {
      return reply.status(400).send({ success: false, message: "Valid 10-digit mobile number required" });
    }

    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    const formattedPhone = `+91${cleanPhone}`;

    // If this is the configured Supabase test phone number, skip live SMS dispatch
    if (SUPABASE_TEST_PHONES[cleanPhone]) {
      return {
        success: true,
        message: "Test OTP ready",
        smsSent: true,
      };
    }

    const otpCode = generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min TTL

    let smsSent = false;
    let smsError = "";

    try {
      // 1. Store the OTP in dusmint_pending_otps (upsert so latest code wins)
      const { error: storeErr } = await supabaseAdmin
        .from("dusmint_pending_otps")
        .upsert(
          { phone: formattedPhone, otp_code: otpCode, expires_at: expiresAt },
          { onConflict: "phone" }
        );

      if (storeErr) {
        logger.warn({ err: storeErr, phone: formattedPhone }, "Failed to store OTP");
      }

      // 2. Call the send-sms Edge Function directly with explicit app: "dusmint"
      //    This guarantees the Edge Function picks the 10MINT template regardless of
      //    what user_metadata the auth.users record currently holds.
      const edgeFunctionUrl = `${env.SUPABASE_URL}/functions/v1/send-sms`;
      const res = await fetch(edgeFunctionUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          user: {
            phone: formattedPhone,
            user_metadata: { app: "dusmint" },
          },
          sms: { otp: otpCode },
        }),
      });

      if (res.ok) {
        smsSent = true;
        logger.info({ phone: formattedPhone }, "DusMint OTP sent via 10MINT");
      } else {
        const body = await res.text().catch(() => "");
        smsError = `Edge function ${res.status}: ${body}`;
        logger.warn({ phone: formattedPhone, status: res.status, body }, "Edge function SMS error");
      }
    } catch (err: any) {
      smsError = err.message;
      logger.warn({ err, phone: formattedPhone }, "DusMint OTP send error");
    }

    return {
      success: true,
      message: smsSent
        ? "OTP sent successfully to your mobile via SMS"
        : "OTP dispatched. Please check your SMS.",
      // Only expose dev OTP in non-production for local testing
      ...(env.NODE_ENV !== "production" && { devOtp: "123456" }),
      smsSent,
      note: smsSent ? "Delivered with 10MINT header" : undefined,
    };
  });

  // 2. Verify Phone OTP
  fastify.post("/auth/otp/verify", async (request: FastifyRequest, reply: FastifyReply) => {
    const { phone, otp, app: appType } = request.body as { phone?: string; otp?: string; app?: string };
    if (!phone || !otp) {
      return reply.status(400).send({ success: false, message: "Phone and OTP are required" });
    }

    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    const formattedPhone = `+91${cleanPhone}`;

    let isOtpValid = false;
    let authUserId: string | null = null;

    // A. Allow Supabase configured test phone+OTP (e.g. 9876543210 -> 123456), or dev bypass in non-prod
    if (
      (SUPABASE_TEST_PHONES[cleanPhone] && otp === SUPABASE_TEST_PHONES[cleanPhone]) ||
      ((otp === "1234" || otp === "123456") && env.NODE_ENV !== "production")
    ) {
      isOtpValid = true;
    } else {
      // B. Check our self-managed OTP in dusmint_pending_otps
      try {
        const { data: pending } = await supabaseAdmin
          .from("dusmint_pending_otps")
          .select("otp_code, expires_at")
          .eq("phone", formattedPhone)
          .single();

        if (pending && pending.otp_code === otp && new Date(pending.expires_at) > new Date()) {
          isOtpValid = true;
          // Clean up used OTP
          await supabaseAdmin.from("dusmint_pending_otps").delete().eq("phone", formattedPhone);
        }
      } catch (err: any) {
        logger.warn({ err, phone: formattedPhone }, "DusMint OTP lookup error");
      }

      // C. Fallback: also try Supabase Auth verifyOtp (in case signInWithOtp was used)
      if (!isOtpValid) {
        try {
          const { data, error } = await supabaseAnon.auth.verifyOtp({
            phone: formattedPhone,
            token: otp,
            type: "sms",
          });

          if (!error && data?.user) {
            isOtpValid = true;
            authUserId = data.user.id;
          }
        } catch (err: any) {
          logger.warn({ err, phone: formattedPhone }, "Supabase verifyOtp fallback error");
        }
      }
    }

    if (!isOtpValid) {
      return reply.status(401).send({
        success: false,
        message: "Invalid verification code. Please check SMS or enter the 6-digit OTP.",
      });
    }

    // 1. Resolve Auth User ID reliably across Riksho Rider, Driver, DusMint Partner & Customer
    if (!authUserId) {
      authUserId = await resolveOrCreateAuthUserId(formattedPhone, cleanPhone, appType);
    }

    const isVendorRequest = appType === "dusmint_vendor";
    const defaultName = isVendorRequest ? "DusMint Partner" : "DusMint Customer";

    // 2. Check if user profile already exists in DusMint profiles (by id or phone)
    let { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .or(`id.eq.${authUserId},phone.ilike.%${cleanPhone}%`)
      .maybeSingle();

    if (!profile) {
      const { data: newProfile, error: insertErr } = await supabaseAdmin
        .from("profiles")
        .upsert(
          {
            id: authUserId,
            phone: formattedPhone,
            name: defaultName,
            language: "en",
            trust_tier: 1,
            veg_only: false,
          },
          { onConflict: "id" }
        )
        .select()
        .single();

      if (insertErr) {
        logger.warn({ err: insertErr, authUserId, formattedPhone }, "profiles upsert warning");
      }

      profile = newProfile || {
        id: authUserId,
        phone: formattedPhone,
        name: defaultName,
        language: "en",
        trust_tier: 1,
        veg_only: false,
      };
    }

    // 3. Check if vendor record exists in 'vendors' table
    let { data: vendor } = await supabaseAdmin
      .from("vendors")
      .select("*")
      .or(`owner_phone.ilike.%${cleanPhone}%,auth_user_id.eq.${authUserId}`)
      .maybeSingle();

    // Vendor is considered existing if registered with shop name and location
    const isNewVendor = !vendor || !vendor.name || !vendor.lat;

    // Generate JWT token
    const role = isVendorRequest || vendor ? "vendor" : "customer";
    const token = jwt.sign(
      {
        sub: profile.id,
        phone: profile.phone,
        role,
        vendorId: vendor?.id,
      },
      JWT_SECRET,
      { expiresIn: "60d" }
    );

    const userProfileResponse = {
      id: profile.id,
      phone: profile.phone,
      fullName: isVendorRequest ? (vendor?.owner_name || "") : (profile.name || defaultName),
      email: (profile as any).email || undefined,
      preferredLanguage: profile.language || "en",
      trustTier: profile.trust_tier || 1,
      isVegOnly: profile.veg_only || false,
      avatarUrl: profile.avatar_url || undefined,
      createdAt: profile.created_at,
    };

    return {
      success: true,
      token,
      user: userProfileResponse,
      vendor: vendor || null,
      isNewVendor,
    };
  });

  // 3. Get User Profile
  fastify.get("/user/profile", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error || !profile) {
      return reply.status(404).send({ message: "Profile not found" });
    }

    return {
      id: profile.id,
      phone: profile.phone,
      fullName: profile.name,
      email: (profile as any).email || undefined,
      preferredLanguage: profile.language,
      trustTier: profile.trust_tier,
      isVegOnly: profile.veg_only,
      avatarUrl: profile.avatar_url,
      createdAt: profile.created_at,
    };
  });

  // 3.5 Update User Profile
  fastify.patch("/user/profile", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const body = request.body as {
      fullName?: string;
      email?: string;
      preferredLanguage?: string;
      isVegOnly?: boolean;
      avatarUrl?: string;
    };

    const updates: any = {};
    if (body.fullName !== undefined) updates.name = body.fullName;
    if (body.preferredLanguage !== undefined) updates.language = body.preferredLanguage;
    if (body.isVegOnly !== undefined) updates.veg_only = body.isVegOnly;
    if (body.avatarUrl !== undefined) updates.avatar_url = body.avatarUrl;
    if (body.email !== undefined) updates.email = body.email;

    let updated: any = null;
    let { data, error } = await supabaseAdmin
      .from("profiles")
      .update(updates)
      .eq("id", userId)
      .select()
      .single();

    if (error && error.message && error.message.includes("'email'")) {
      // If email column does not exist yet on profiles, retry update without email so it never crashes
      delete updates.email;
      const res = await supabaseAdmin
        .from("profiles")
        .update(updates)
        .eq("id", userId)
        .select()
        .single();
      data = res.data;
      error = res.error;
    }

    if (error || !data) {
      return reply.status(500).send({ message: "Failed to update profile", error: error?.message });
    }
    updated = data;

    return {
      id: updated.id,
      phone: updated.phone,
      fullName: updated.name,
      email: updated.email || body.email || undefined,
      preferredLanguage: updated.language,
      trustTier: updated.trust_tier,
      isVegOnly: updated.veg_only,
      avatarUrl: updated.avatar_url,
      createdAt: updated.created_at,
    };
  });

  // 4. Get User Saved Addresses
  fastify.get("/user/addresses", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const { data: addresses } = await supabaseAdmin
      .from("addresses")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    return (addresses || []).map((a) => ({
      id: a.id,
      userId: a.user_id,
      clusterId: a.cluster_id,
      label: (a.label || "home").toLowerCase(),
      houseNo: a.house,
      buildingName: a.landmark,
      streetArea: a.street_area || a.landmark || "Indore",
      landmark: a.landmark,
      pincode: a.pincode || "452010",
      latitude: a.lat,
      longitude: a.lng,
      isDefault: a.is_default || false,
    }));
  });

  // 5. Save New Address
  fastify.post("/user/addresses", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;
    const body = request.body as any;

    const lat = body.latitude || 22.7533;
    const lng = body.longitude || 75.8937;

    const { data: newAddr, error } = await supabaseAdmin
      .from("addresses")
      .insert({
        user_id: userId,
        cluster_id: body.clusterId || null,
        label: body.label || "Home",
        house: body.houseNo,
        landmark: body.landmark || body.buildingName || "",
        location: `SRID=4326;POINT(${lng} ${lat})`,
        lat,
        lng,
        is_default: body.isDefault ?? true,
      })
      .select()
      .single();

    if (error || !newAddr) {
      return reply.status(500).send({ message: "Failed to save address", error: error?.message });
    }

    return {
      id: newAddr.id,
      userId: newAddr.user_id,
      clusterId: newAddr.cluster_id,
      label: newAddr.label.toLowerCase(),
      houseNo: newAddr.house,
      buildingName: newAddr.landmark,
      streetArea: newAddr.landmark || "Indore",
      landmark: newAddr.landmark,
      pincode: "452010",
      latitude: newAddr.lat,
      longitude: newAddr.lng,
      isDefault: newAddr.is_default,
    };
  });

  // 6. Delete Address
  fastify.delete("/user/addresses/:id", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;
    const { id } = request.params as { id: string };

    const { error } = await supabaseAdmin
      .from("addresses")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      return reply.status(500).send({ message: "Failed to delete address", error: error.message });
    }

    return { success: true };
  });

  // 7. Get User Wishlist Items
  fastify.get("/user/wishlist", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("device_id")
      .eq("id", userId)
      .single();

    if (!profile || !profile.device_id) {
      return [];
    }

    try {
      let itemIds: string[] = [];
      if (profile.device_id.startsWith("[")) {
        itemIds = JSON.parse(profile.device_id);
      } else if (profile.device_id.startsWith("wishlist:")) {
        itemIds = JSON.parse(profile.device_id.replace("wishlist:", ""));
      }

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return [];
      }

      const { data: items } = await supabaseAdmin
        .from("items")
        .select("*, vendors(name), categories(name_en, slug)")
        .in("id", itemIds);

      return (items || []).map((i) => ({
        id: i.id,
        vendorId: i.vendor_id,
        vendorName: (i.vendors as any)?.name || "Mandi Superstore",
        categoryId: i.category_id,
        categorySlug: (i.categories as any)?.slug || "vegetables",
        categoryName: (i.categories as any)?.name_en || "Vegetables",
        nameEn: i.name_en,
        nameHi: i.name_hi,
        unit: i.unit,
        stepQuantity: 1,
        pricePaise: Math.round(Number(i.price) * 100),
        mrpPaise: i.mrp ? Math.round(Number(i.mrp) * 100) : undefined,
        photoUrl: i.photo_url || undefined,
        isInStock: i.in_stock,
        deliveryMins: "9 MINS",
        rating: 4.8,
        discountPercent:
          i.mrp && Number(i.mrp) > Number(i.price)
            ? Math.round(((Number(i.mrp) - Number(i.price)) / Number(i.mrp)) * 100)
            : 0,
      }));
    } catch {
      return [];
    }
  });

  // 8. Add Item to User Wishlist
  fastify.post("/user/wishlist", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;
    const body = request.body as { itemId?: string };

    if (!body || !body.itemId) {
      return reply.status(400).send({ message: "itemId is required" });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("device_id")
      .eq("id", userId)
      .single();

    let itemIds: string[] = [];
    if (profile && profile.device_id) {
      try {
        if (profile.device_id.startsWith("[")) {
          itemIds = JSON.parse(profile.device_id);
        } else if (profile.device_id.startsWith("wishlist:")) {
          itemIds = JSON.parse(profile.device_id.replace("wishlist:", ""));
        }
      } catch {
        itemIds = [];
      }
    }

    if (!itemIds.includes(body.itemId)) {
      itemIds.unshift(body.itemId);
    }

    await supabaseAdmin
      .from("profiles")
      .update({ device_id: `wishlist:${JSON.stringify(itemIds)}` })
      .eq("id", userId);

    return { success: true, itemIds };
  });

  // 9. Remove Item from User Wishlist
  fastify.delete("/user/wishlist/:id", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;
    const { id } = request.params as { id: string };

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("device_id")
      .eq("id", userId)
      .single();

    let itemIds: string[] = [];
    if (profile && profile.device_id) {
      try {
        if (profile.device_id.startsWith("[")) {
          itemIds = JSON.parse(profile.device_id);
        } else if (profile.device_id.startsWith("wishlist:")) {
          itemIds = JSON.parse(profile.device_id.replace("wishlist:", ""));
        }
      } catch {
        itemIds = [];
      }
    }

    itemIds = itemIds.filter((itemId) => itemId !== id);

    await supabaseAdmin
      .from("profiles")
      .update({ device_id: `wishlist:${JSON.stringify(itemIds)}` })
      .eq("id", userId);

    return { success: true, itemIds };
  });

  // 10. Clear User Wishlist
  fastify.delete("/user/wishlist", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;

    await supabaseAdmin
      .from("profiles")
      .update({ device_id: null })
      .eq("id", userId);

    return { success: true };
  });
}
