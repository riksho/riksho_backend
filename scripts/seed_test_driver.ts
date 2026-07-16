import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

import WebSocket from "ws";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Node 20 workaround for Supabase realtime
(global as any).WebSocket = WebSocket;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    fetch: fetch,
  }
});

async function seedTestDriver() {
  const phone = "+919876543210";
  console.log(`Checking if user with phone ${phone} exists...`);

  // 1. Create or get user
  let userId: string;

  // Supabase doesn't have a direct get user by phone that is always reliable without listing,
  // but we can just try to create and catch the error, or list users.
  const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  
  const existingUser = users?.find(u => u.phone === "919876543210" || u.phone === "+919876543210");
  
  if (existingUser) {
    console.log(`User already exists with ID: ${existingUser.id}`);
    userId = existingUser.id;
  } else {
    console.log(`Creating user...`);
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      phone,
      phone_confirm: true,
      user_metadata: { role: "driver" }
    });

    if (createError) {
      console.error("Failed to create user:", createError);
      process.exit(1);
    }
    console.log(`User created with ID: ${newUser.user.id}`);
    userId = newUser.user.id;
  }

  // 2. Set role in users table (if public.users exists)
  await supabaseAdmin.from("users").upsert({
    id: userId,
    phone,
    role: "driver"
  });

  // 3. Upsert driver profile
  console.log("Upserting driver profile...");
  const { error: driverError } = await supabaseAdmin.from("drivers").upsert({
    id: userId,
    name: "Test Driver",
    phone,
    license_no: "MH12TEST0001",
    status: "offline",
    partner_type: "cab_bike",
    rating: 4.9,
    is_verified: true,
    verification_status: "approved"
  });

  if (driverError) {
    console.error("Failed to upsert driver:", driverError);
    process.exit(1);
  }

  // 4. Upsert vehicle
  console.log("Upserting vehicle...");
  const { data: existingVehicle } = await supabaseAdmin.from("vehicles").select("id").eq("driver_id", userId).maybeSingle();
  if (!existingVehicle) {
    const { error: vehicleError } = await supabaseAdmin.from("vehicles").insert({
      driver_id: userId,
      type: "bike",
      plate: "MH12AB1234",
      model: "Honda Activa"
    });
    if (vehicleError) console.error("Failed to insert vehicle:", vehicleError);
  }

  // 5. Upsert documents
  console.log("Upserting driver documents...");
  const docs = ["license", "rc", "insurance", "vehicle_photo", "profile_photo"];
  for (const doc of docs) {
    // Generate a deterministic UUID for the document based on driverId and doc type
    // We'll just insert/upsert if we don't have a strict PK constraint. 
    // Wait, the id is uuid pk. We can just insert if not exists.
    const { data: existingDoc } = await supabaseAdmin.from("driver_documents")
      .select("id")
      .eq("driver_id", userId)
      .eq("doc_type", doc)
      .single();

    if (!existingDoc) {
      await supabaseAdmin.from("driver_documents").insert({
        driver_id: userId,
        doc_type: doc,
        storage_path: "test/mock_path.jpg",
        status: "approved"
      });
    } else {
      await supabaseAdmin.from("driver_documents")
        .update({ status: "approved" })
        .eq("id", existingDoc.id);
    }
  }

  console.log("🎉 Test driver successfully seeded and verified!");
  console.log("\n⚠️ IMPORTANT ⚠️");
  console.log("To log in with OTP '123456', you MUST configure this phone number in your Supabase Dashboard:");
  console.log("1. Go to Authentication -> Providers -> Phone");
  console.log("2. Under 'Test numbers', add '+919876543210' with OTP '123456'");
  console.log("3. Save changes.");
}

seedTestDriver().catch(console.error);
