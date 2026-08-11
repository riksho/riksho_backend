import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config({ path: "c:/Users/shaws/Riksho/riksho_backend/.env" });

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDrivers() {
  console.log("Checking drivers...");
  const { data: drivers } = await supabase.from("drivers").select("id, status, is_verified, active_vehicle_id, users(email)");
  console.log("Drivers:", drivers);

  console.log("Checking driver locations...");
  const { data: locs } = await supabase.from("driver_locations").select("driver_id, updated_at");
  console.log("Locations (last 10 mins):", locs);

  console.log("Checking vehicles...");
  const { data: vehicles } = await supabase.from("vehicles").select("id, driver_id, type");
  console.log("Vehicles:", vehicles);
}

checkDrivers().catch(console.error);
