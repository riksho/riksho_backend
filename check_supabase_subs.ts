import { supabaseAdmin } from "./src/config/supabase.js";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("driver_subscriptions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("=== LATEST DRIVER SUBSCRIPTIONS IN SUPABASE ===");
  if (error) console.error(error);
  else console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
