import { supabaseAdmin } from "./src/config/supabase.js";

async function main() {
  const driverId = "fa3fa1d1-0fcd-48fe-89d1-752721f04daa";
  const { data, error } = await supabaseAdmin
    .from("drivers")
    .select("*, vehicles!vehicles_driver_id_fkey(*), driver_documents(*)")
    .eq("id", driverId)
    .single();

  if (error) console.error("Query error:", error);
  else console.log("Profile result:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
