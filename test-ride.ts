import { findNearbyDrivers } from "./src/modules/matching/matching.service.js";
import { supabaseAdmin } from "./src/config/supabase.js";
import { logger } from "./src/common/logger.js";

async function testRide() {
  const customerId = "a6706e5c-8174-4277-b680-87f49d21fa1a";
  const driverLat = 22.5094661;
  const driverLng = 88.260799;
  
  console.log("🚕 Creating a dummy test ride exactly at driver's location...");
  
  const { data: ride, error } = await supabaseAdmin.from("rides").insert({
    customer_id: customerId,
    status: "requested",
    vehicle_type: "auto",
    origin_lat: driverLat + 0.001, // Slightly offset so it's ~100 meters away
    origin_lng: driverLng + 0.001,
    origin_address: "Terminal Test Location",
    dest_lat: driverLat + 0.05,
    dest_lng: driverLng + 0.05,
    dest_address: "Destination Alpha",
    distance_m: 5500,
    duration_s: 1200,
    fare_estimate: 150.00
  }).select().single();

  if (error) {
    console.error("❌ Failed to create test ride:", error);
    return;
  }

  console.log("✅ Test ride created with ID:", ride.id);
  console.log("📡 Triggering matching service wave 1...");
  
  await findNearbyDrivers(ride.origin_lat, ride.origin_lng, "auto", ride.id, "move");
  
  console.log("🎉 Test complete! Check your physical Android phone!");
  process.exit(0);
}

testRide();
