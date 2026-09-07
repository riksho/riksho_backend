import { supabaseAdmin } from "./src/config/supabase.js";

async function main() {
  const driverId = "fa3fa1d1-0fcd-48fe-89d1-752721f04daa";
  console.log("Updating vehicle in Supabase for driver:", driverId);

  const { data: updatedVehicle, error: updateError } = await supabaseAdmin
    .from("vehicles")
    .update({
      type: "car",
      model: "Maruti Suzuki WagonR",
      plate: "DL3CAA1987",
      seats: 4
    })
    .eq("driver_id", driverId)
    .select()
    .single();

  if (updateError) {
    console.error("Update error:", updateError);
    return;
  }
  console.log("Updated vehicle row successfully:", updatedVehicle);

  console.log("\n--- Testing Backend Profile Fetch ---");
  const { data: profile, error: pError } = await supabaseAdmin
    .from("drivers")
    .select("*, vehicles!vehicles_driver_id_fkey(*), driver_documents(*)")
    .eq("id", driverId)
    .single();

  if (pError) {
    console.error("Profile fetch error:", pError);
  } else {
    console.log("Fetched Profile Vehicle:", profile.vehicles);
  }

  console.log("\n--- Testing Admin Drivers Fetch ---");
  const { data: adminDrivers, error: aError } = await supabaseAdmin
    .from("drivers")
    .select("id, name, phone, license_no, status, verification_status, is_verified, rating, total_trips, created_at, vehicles!vehicles_driver_id_fkey(type, plate, model)")
    .order("created_at", { ascending: false });

  if (aError) {
    console.error("Admin fetch error:", aError);
  } else {
    console.log("Admin Drivers List:", JSON.stringify(adminDrivers, null, 2));
  }
}

main().catch(console.error);
