import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    transport: WebSocket as any,
  },
});

async function runMigrations() {
  const migrationsDir = path.resolve(__dirname, "../../migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  console.log(`📦 Found ${files.length} migration(s):`);
  files.forEach((f) => console.log(`   - ${f}`));
  console.log("");

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, "utf-8");

    console.log(`⏳ Running: ${file}...`);

    const { error } = await supabase.rpc("exec_sql", { sql_query: sql });

    if (error) {
      // If the RPC doesn't exist, try a direct approach
      console.warn(`   ⚠️  RPC exec_sql not available. Manual migration required.`);
      console.log(`   📋 Copy the SQL from: ${filePath}`);
      console.log(`   📋 Paste it in: Supabase Dashboard → SQL Editor → New Query → Run`);
      console.log("");
    } else {
      console.log(`   ✅ ${file} applied successfully!`);
    }
  }

  console.log("\n🎉 Migration process complete!");
}

runMigrations().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
