import { supabaseAdmin } from "./src/config/supabase.js";

async function main() {
  const { data: rcData } = await supabaseAdmin.storage
    .from("documents")
    .createSignedUrl("fa3fa1d1-0fcd-48fe-89d1-752721f04daa/rc_1788815246007.jpg", 3600);
  console.log("RC Signed URL:", rcData?.signedUrl);

  const { data: vpData } = await supabaseAdmin.storage
    .from("documents")
    .createSignedUrl("fa3fa1d1-0fcd-48fe-89d1-752721f04daa/vehicle_photo_1788815250312.jpg", 3600);
  console.log("Vehicle Photo Signed URL:", vpData?.signedUrl);
}

main().catch(console.error);
