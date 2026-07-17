import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import WebSocket from "ws";

dotenv.config();

(global as any).WebSocket = WebSocket;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch }
});

async function run() {
  const phone = "+919876543210";
  const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
  const testUser = users?.find(u => u.phone === "919876543210" || u.phone === "+919876543210");

  if (!testUser) {
    console.error("Test user not found");
    process.exit(1);
  }
  const userId = testUser.id;
  console.log(`Found test user: ${userId}`);

  const pdfPath = path.resolve(process.cwd(), "scripts/riksho_test_doc.pdf");
  const fileBuffer = fs.readFileSync(pdfPath);

  // Ensure bucket exists or we just use it
  const bucketName = "driver-docs";

  const docs = ["license", "rc", "insurance", "vehicle_photo", "profile_photo"];
  for (const doc of docs) {
    const storagePath = `${userId}/${doc}.pdf`;
    console.log(`Uploading ${storagePath}...`);

    const { error: uploadError } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(storagePath, fileBuffer, {
        contentType: "application/pdf",
        upsert: true
      });

    if (uploadError) {
      console.error(`Error uploading ${doc}:`, uploadError);
    } else {
      console.log(`Upload successful for ${doc}. Updating database...`);
      await supabaseAdmin.from("driver_documents")
        .update({ storage_path: storagePath, status: "approved" })
        .eq("driver_id", userId)
        .eq("doc_type", doc);
    }
  }
  console.log("All test documents uploaded and linked successfully!");
}

run().catch(console.error);
