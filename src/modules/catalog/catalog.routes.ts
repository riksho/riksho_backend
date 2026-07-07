import { FastifyInstance } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";
import { z } from "zod";

const GetCatalogSchema = z.object({
  darkstore_id: z.string().uuid(),
});

export async function catalogRoutes(app: FastifyInstance) {
  // GET /catalog/products?darkstore_id=...
  // Returns products available at a specific darkstore with their inventory levels
  app.get("/catalog/products", async (request, reply) => {
    const query = GetCatalogSchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "Missing or invalid darkstore_id" });
    }

    const darkstoreId = query.data.darkstore_id;

    // Join products with darkstore_inventory
    const { data: catalog, error } = await supabaseAdmin
      .from("products")
      .select(`
        id, sku, name, description, category, image_url, price,
        darkstore_inventory!inner(qty_available)
      `)
      .eq("is_active", true)
      .eq("darkstore_inventory.darkstore_id", darkstoreId);

    if (error) {
      return reply.status(500).send({ error: "Failed to fetch catalog" });
    }

    // Flatten the nested inventory object for the client
    const formattedCatalog = catalog.map(p => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      image_url: p.image_url,
      price: p.price,
      qty_available: Array.isArray(p.darkstore_inventory) 
        ? p.darkstore_inventory[0]?.qty_available || 0 
        : (p.darkstore_inventory as any)?.qty_available || 0
    }));

    return reply.send({ products: formattedCatalog });
  });

  // GET /catalog/products/:id
  app.get("/catalog/products/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data: product, error } = await supabaseAdmin
      .from("products")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !product) {
      return reply.status(404).send({ error: "Product not found" });
    }

    return reply.send({ product });
  });
}
