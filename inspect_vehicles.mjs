import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://llvulxhjpyztuoorcacz.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdnVseGhqcHl6dHVvb3JjYWN6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzA3MTE2MCwiZXhwIjoyMDk4NjQ3MTYwfQ.x6D9dCrJX6wYxzfhP5z1xJA7udZxr_89kc5r8R-Govg";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  console.log("=== DRIVERS ===");
  const { data: drivers, error: dErr } = await supabase.from('drivers').select('*');
  if (dErr) console.error("drivers err:", dErr);
  else console.log(JSON.stringify(drivers, null, 2));

  console.log("=== VEHICLES ===");
  const { data: vehicles, error: vErr } = await supabase.from('vehicles').select('*');
  if (vErr) console.error("vehicles err:", vErr);
  else console.log(JSON.stringify(vehicles, null, 2));

  console.log("=== DRIVER DOCUMENTS ===");
  const { data: docs, error: docErr } = await supabase.from('driver_documents').select('*');
  if (docErr) console.error("docs err:", docErr);
  else console.log(JSON.stringify(docs, null, 2));
}

main();
