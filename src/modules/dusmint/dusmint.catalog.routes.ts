import type { FastifyInstance, FastifyRequest } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";

export async function dusmintCatalogRoutes(fastify: FastifyInstance) {
  // 1. Get catalogue items for a specific vendor
  fastify.get("/vendors/:vendorId/items", async (request: FastifyRequest) => {
    const { vendorId } = request.params as { vendorId: string };

    const { data: items } = await supabaseAdmin
      .from("items")
      .select("*, categories(name_en, name_hi)")
      .eq("vendor_id", vendorId)
      .order("name_en", { ascending: true });

    return (items || []).map((i: any) => ({
      id: i.id,
      vendorId: i.vendor_id,
      categoryId: i.category_id || "cat-general",
      categoryName: i.categories?.name_en || i.category || "Vegetables",
      nameEn: i.name_en,
      nameHi: i.name_hi,
      unit: i.unit,
      stepQuantity: 1,
      pricePaise: Math.round(Number(i.price) * 100),
      mrpPaise: i.mrp ? Math.round(Number(i.mrp) * 100) : undefined,
      mandiBandMinPaise: i.band_min ? Math.round(Number(i.band_min) * 100) : undefined,
      mandiBandMaxPaise: i.band_max ? Math.round(Number(i.band_max) * 100) : undefined,
      photoUrl: i.photo_url || undefined,
      isInStock: i.in_stock !== false,
      stockKg: i.stock_kg ?? undefined,
      stockGrams: i.stock_grams ?? undefined,
    }));
  });

  // 2. Get all catalogue items (filterable by category)
  fastify.get("/items", async (request: FastifyRequest) => {
    const { categoryId } = request.query as { categoryId?: string };

    let query = supabaseAdmin
      .from("items")
      .select("*, categories(slug, name_en), vendors(name, category)")
      .eq("in_stock", true);

    if (categoryId) {
      query = query.eq("category_id", categoryId);
    }

    const { data: items } = await query.limit(60);

    return (items || []).map((i) => ({
      id: i.id,
      vendorId: i.vendor_id,
      vendorName: (i.vendors as any)?.name || "Local Store",
      categoryId: i.category_id,
      categorySlug: (i.categories as any)?.slug || "vegetables",
      categoryName: (i.categories as any)?.name_en || "Vegetables",
      nameEn: i.name_en,
      nameHi: i.name_hi,
      unit: i.unit,
      stepQuantity: 1,
      pricePaise: Math.round(Number(i.price) * 100),
      mrpPaise: i.mrp ? Math.round(Number(i.mrp) * 100) : undefined,
      mandiBandMinPaise: i.band_min ? Math.round(Number(i.band_min) * 100) : undefined,
      mandiBandMaxPaise: i.band_max ? Math.round(Number(i.band_max) * 100) : undefined,
      photoUrl: i.photo_url || undefined,
      isInStock: i.in_stock,
    }));
  });
}
