import { supabaseAdmin } from "./src/config/supabase.js";

async function main() {
  // Let's check tables and columns in PostgreSQL by querying information_schema
  // Since we don't have direct SQL terminal, we can use PostgREST or test tables.
  console.log("Checking all known tables for data related to driver fa3fa1d1-0fcd-48fe-89d1-752721f04daa...");

  // Let's check driver_documents
  const { data: docs } = await supabaseAdmin.from("driver_documents")
    .select("*")
    .eq("driver_id", "fa3fa1d1-0fcd-48fe-89d1-752721f04daa");
  console.log("driver_documents:", docs);

  // Let's check drivers
  const { data: driver } = await supabaseAdmin.from("drivers")
    .select("*")
    .eq("id", "fa3fa1d1-0fcd-48fe-89d1-752721f04daa");
  console.log("driver:", driver);

  // Let's check vehicles
  const { data: veh } = await supabaseAdmin.from("vehicles")
    .select("*")
    .eq("driver_id", "fa3fa1d1-0fcd-48fe-89d1-752721f04daa");
  console.log("vehicles:", veh);

  // Let's check rides
  const { data: rides } = await supabaseAdmin.from("rides")
    .select("*")
    .eq("driver_id", "fa3fa1d1-0fcd-48fe-89d1-752721f04daa");
  console.log("rides for driver:", rides);

  // Let's check if there are any other vehicles rows in public.vehicles
  const { data: allVeh } = await supabaseAdmin.from("vehicles").select("*");
  console.log("ALL VEHICLES IN DB:", allVeh);
}

main().catch(console.error);
