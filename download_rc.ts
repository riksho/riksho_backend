import { supabaseAdmin } from "./src/config/supabase.js";
import fs from "fs";

async function main() {
  const { data, error } = await supabaseAdmin.storage
    .from("documents")
    .download("fa3fa1d1-0fcd-48fe-89d1-752721f04daa/rc_1788815246007.jpg");

  if (error) {
    console.error(error);
    return;
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync("C:/Users/shaws/.gemini/antigravity-ide/brain/ff87b482-3d22-4afb-a508-1073b3c6701f/scratch/uploaded_rc.jpg", buffer);
  console.log("Downloaded RC to scratch!");
}

main().catch(console.error);
