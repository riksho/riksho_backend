import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config({ path: "c:/Users/shaws/Riksho/riksho_backend/.env" });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
  const res = await supabase.rpc("exec_sql", { sql_query: "SELECT 1 as test;" });
  console.log("exec_sql response:", JSON.stringify(res, null, 2));
}

test().catch(console.error);
