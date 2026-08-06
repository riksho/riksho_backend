import { supabaseAdmin } from "../config/supabase.js";
import { logger } from "./logger.js";

/** How long a document preview link stays valid. */
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Attach a short-lived `signed_url` to each driver_documents row.
 *
 * The `documents` bucket is private by design — it holds driving licenses, ID
 * proofs and selfies. A `/object/public/...` URL therefore returns 400, and the
 * anon key cannot sign for another user's files. Signing has to happen here,
 * with the service_role key, so clients never construct storage URLs themselves.
 *
 * Failures degrade to `signed_url: null` rather than throwing: one unreadable
 * document should not take down the whole profile or admin detail response.
 */
export async function withSignedUrls<T extends { storage_path?: string | null }>(
  docs: T[] | null | undefined
): Promise<(T & { signed_url: string | null })[]> {
  if (!docs?.length) return [];

  return Promise.all(
    docs.map(async (doc) => {
      if (!doc?.storage_path) return { ...doc, signed_url: null };

      const { data, error } = await supabaseAdmin.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);

      if (error) {
        logger.error({ path: doc.storage_path, error }, "Failed to sign document URL");
        return { ...doc, signed_url: null };
      }

      return { ...doc, signed_url: data.signedUrl };
    })
  );
}
