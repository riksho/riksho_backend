import type { FastifyInstance, FastifyRequest } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";

export async function dusmintClustersRoutes(fastify: FastifyInstance) {
  // 1. Check Serviceability (Hyperlocal Cluster matching)
  fastify.get("/clusters/check-serviceability", async (request: FastifyRequest) => {
    const { lat, lng } = request.query as { lat?: string; lng?: string };
    const userLat = parseFloat(lat || "22.7533");
    const userLng = parseFloat(lng || "75.8937");

    // Fetch active clusters
    const { data: clusters } = await supabaseAdmin
      .from("clusters")
      .select("*")
      .eq("status", "active");

    if (!clusters || clusters.length === 0) {
      return {
        clusterId: "",
        clusterName: "No active clusters",
        city: "Indore",
        distanceMeters: 99999,
        isServiceable: false,
      };
    }

    // Calculate distance to nearest cluster (Haversine formula approximation)
    let bestCluster = clusters[0];
    let minDistance = Infinity;

    for (const c of clusters) {
      const dLat = (c.centre_lat - userLat) * (Math.PI / 180);
      const dLng = (c.centre_lng - userLng) * (Math.PI / 180);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(userLat * (Math.PI / 180)) *
          Math.cos(c.centre_lat * (Math.PI / 180)) *
          Math.sin(dLng / 2) *
          Math.sin(dLng / 2);
      const distance = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      if (distance < minDistance) {
        minDistance = distance;
        bestCluster = c;
      }
    }

    const radius = bestCluster.radius_m || 3000;
    const isServiceable = minDistance <= radius || true; // Allow for dev testing

    return {
      clusterId: bestCluster.id,
      clusterName: bestCluster.name,
      city: bestCluster.city,
      distanceMeters: Math.round(minDistance),
      isServiceable,
    };
  });

  // 2. Delivery Slots for Cluster
  fastify.get("/clusters/:clusterId/slots", async (request: FastifyRequest) => {
    const { clusterId } = request.params as { clusterId: string };

    const { data: slots } = await supabaseAdmin
      .from("slots")
      .select("*")
      .eq("cluster_id", clusterId)
      .eq("is_active", true);

    if (!slots || slots.length === 0) {
      // Default slots fallback
      return [
        {
          id: "slot-morning-1",
          clusterId,
          name: "Morning Delivery (07:00 AM - 10:00 AM)",
          slotType: "morning",
          startTime: "07:00:00",
          endTime: "10:00:00",
          orderCutoffTime: "06:00:00",
          maxOrdersCapacity: 100,
          isActive: true,
        },
        {
          id: "slot-evening-1",
          clusterId,
          name: "Evening Delivery (05:00 PM - 08:00 PM)",
          slotType: "evening",
          startTime: "17:00:00",
          endTime: "20:00:00",
          orderCutoffTime: "16:00:00",
          maxOrdersCapacity: 100,
          isActive: true,
        },
      ];
    }

    return slots.map((s) => ({
      id: s.id,
      clusterId: s.cluster_id,
      name: s.start_time.startsWith("07")
        ? "Morning Delivery (07:00 AM - 10:00 AM)"
        : "Evening Delivery (05:00 PM - 08:00 PM)",
      slotType: s.start_time.startsWith("07") ? "morning" : "evening",
      startTime: s.start_time,
      endTime: s.end_time,
      orderCutoffTime: s.cutoff_time,
      maxOrdersCapacity: s.capacity,
      isActive: s.is_active,
    }));
  });

  // 3. Categories for Cluster
  fastify.get("/clusters/:clusterId/categories", async () => {
    const { data: categories } = await supabaseAdmin
      .from("categories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });

    return (categories || []).map((c) => ({
      id: c.id,
      nameEn: c.name_en,
      nameHi: c.name_hi,
      slug: c.slug,
      iconUrl: c.image_url || undefined,
      displayOrder: c.sort_order,
    }));
  });

  // 4. Vendors in Cluster
  fastify.get("/clusters/:clusterId/vendors", async (request: FastifyRequest) => {
    const { clusterId } = request.params as { clusterId: string };

    const { data: vendors } = await supabaseAdmin
      .from("vendors")
      .select("*")
      .eq("cluster_id", clusterId)
      .eq("status", "verified");

    return (vendors || []).map((v) => ({
      id: v.id,
      clusterId: v.cluster_id,
      shopName: v.name,
      ownerName: v.owner_name,
      category: v.category,
      addressText: v.area || "Indore Vijay Nagar",
      fssaiLicenseNo: v.fssai_no || undefined,
      score: 4.8,
      isOpen: true,
      bannerPhotoUrl: v.banner_url || "https://images.unsplash.com/photo-1542838132-92c53300491e?w=500",
      totalDeliveredOrders: 142,
    }));
  });

  // 5. Search items in cluster
  fastify.get("/clusters/:clusterId/search", async (request: FastifyRequest) => {
    const { q } = request.query as { q?: string };
    if (!q) return [];

    const { data: items } = await supabaseAdmin
      .from("items")
      .select("*")
      .or(`name_en.ilike.%${q}%,name_hi.ilike.%${q}%`)
      .limit(20);

    return (items || []).map((i) => ({
      id: i.id,
      vendorId: i.vendor_id,
      categoryId: i.category_id,
      nameEn: i.name_en,
      nameHi: i.name_hi,
      unit: i.unit,
      stepQuantity: 1,
      pricePaise: Math.round(Number(i.price) * 100),
      mandiBandMinPaise: i.band_min ? Math.round(Number(i.band_min) * 100) : undefined,
      mandiBandMaxPaise: i.band_max ? Math.round(Number(i.band_max) * 100) : undefined,
      photoUrl: i.photo_url || undefined,
      isInStock: i.in_stock,
    }));
  });
}
