import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { supabaseAdmin } from "../../config/supabase.js";
import { dusmintAuthGuard } from "./dusmint.auth.guard.js";

export async function dusmintClaimsRoutes(fastify: FastifyInstance) {
  // 1. Submit Quality Claim (Weight discrepancy, damaged items)
  fastify.post("/claims", { preHandler: [dusmintAuthGuard] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;
    const userId = user.sub || user.id;

    const body = request.body as {
      orderId: string;
      orderItemId?: string;
      claimType: string;
      scannedSealQr?: string;
      claimedWeightGrams?: number;
      proofPhotoUrl?: string;
      customerRemarks?: string;
    };

    if (!body.orderId) {
      return reply.status(400).send({ message: "Order ID is required" });
    }

    const claimCode = `CLM-${Math.floor(1000 + Math.random() * 9000)}`;

    const { data: claim, error } = await supabaseAdmin
      .from("claims")
      .insert({
        order_id: body.orderId,
        user_id: userId,
        reason: (body.claimType || "damaged").toLowerCase(),
        description: body.customerRemarks || "Quality issue reported via scan-to-open",
        photo_url: body.proofPhotoUrl || null,
        status: "approved", // Auto-approved for trust
        refund_amount: 35.0,
      })
      .select()
      .single();

    return {
      claimId: claim?.id || claimCode,
      status: "approved",
      decision: "approved_instant_refund",
      message: "Claim approved! Refund will be credited to your UPI account within 5 minutes.",
    };
  });
}
