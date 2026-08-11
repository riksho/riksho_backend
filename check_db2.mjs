import dotenv from "dotenv";

dotenv.config({ path: "c:/Users/shaws/Riksho/riksho_backend/.env" });

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

async function query(table) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    }
  });
  const data = await res.json();
  console.log(`--- ${table} ---`);
  console.log(JSON.stringify(data, null, 2));
}

async function run() {
  await query('drivers');
  await query('driver_locations');
  await query('vehicles');
}

run().catch(console.error);
