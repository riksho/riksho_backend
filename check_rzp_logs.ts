import { supabaseAdmin } from "./src/config/supabase.js";

async function main() {
  const driverId = "fa3fa1d1-0fcd-48fe-89d1-752721f04daa";
  console.log("=== CHECKING DRIVER SUBSCRIPTIONS IN SUPABASE ===");
  const { data: subs, error: subsErr } = await supabaseAdmin
    .from("driver_subscriptions")
    .select("*")
    .eq("driver_id", driverId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (subsErr) console.error("subsErr:", subsErr);
  else console.log("driver_subscriptions:", JSON.stringify(subs, null, 2));

  console.log("\n=== CHECKING RAZORPAY ORDERS ON TEST KEY ===");
  const testAuth = Buffer.from("rzp_test_Sgd5zdnYIretSl:RI272mxGa3SJtZdKYReSc5mu").toString("base64");
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders?count=10", {
      headers: { Authorization: `Basic ${testAuth}` },
    });
    const data = await res.json();
    console.log("Recent Test Orders:", JSON.stringify(data.items?.map((i: any) => ({
      id: i.id,
      amount: i.amount,
      status: i.status,
      attempts: i.attempts,
      notes: i.notes,
      created_at: new Date(i.created_at * 1000).toISOString(),
    })), null, 2));
  } catch (e) {
    console.error("Test orders fetch error:", e);
  }

  console.log("\n=== CHECKING RAZORPAY PAYMENTS ON TEST KEY ===");
  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=10", {
      headers: { Authorization: `Basic ${testAuth}` },
    });
    const data = await res.json();
    console.log("Recent Test Payments:", JSON.stringify(data.items?.map((p: any) => ({
      id: p.id,
      order_id: p.order_id,
      amount: p.amount,
      status: p.status,
      method: p.method,
      contact: p.contact,
      created_at: new Date(p.created_at * 1000).toISOString(),
    })), null, 2));
  } catch (e) {
    console.error("Test payments fetch error:", e);
  }

  console.log("\n=== CHECKING RAZORPAY ORDERS ON LIVE KEY ===");
  const liveAuth = Buffer.from("rzp_live_SxBDD0fNLPe7Ic:XnWnA07X027Ce3blid0Vlroz").toString("base64");
  try {
    const res = await fetch("https://api.razorpay.com/v1/orders?count=10", {
      headers: { Authorization: `Basic ${liveAuth}` },
    });
    const data = await res.json();
    console.log("Recent Live Orders:", JSON.stringify(data.items?.map((i: any) => ({
      id: i.id,
      amount: i.amount,
      status: i.status,
      attempts: i.attempts,
      notes: i.notes,
      created_at: new Date(i.created_at * 1000).toISOString(),
    })), null, 2));
  } catch (e) {
    console.error("Live orders fetch error:", e);
  }

  console.log("\n=== CHECKING RAZORPAY PAYMENTS ON LIVE KEY ===");
  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=10", {
      headers: { Authorization: `Basic ${liveAuth}` },
    });
    const data = await res.json();
    console.log("Recent Live Payments:", JSON.stringify(data.items?.map((p: any) => ({
      id: p.id,
      order_id: p.order_id,
      amount: p.amount,
      status: p.status,
      method: p.method,
      contact: p.contact,
      error_code: p.error_code,
      error_description: p.error_description,
      created_at: new Date(p.created_at * 1000).toISOString(),
    })), null, 2));
  } catch (e) {
    console.error("Live payments fetch error:", e);
  }
}

main().catch(console.error);
