import dotenv from "dotenv";
dotenv.config({ path: "c:/Users/shaws/Riksho/riksho_backend/.env" });

async function testServiceRole() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch("https://api.supabase.com/v1/projects/llvulxhjpyztuoorcacz/database/query", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "SELECT 1 as test;" }),
  });

  console.log("Status with Service Key:", res.status);
  const text = await res.text();
  console.log("Body:", text);
}

testServiceRole().catch(console.error);
