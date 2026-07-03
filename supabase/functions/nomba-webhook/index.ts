/**
 * nomba-webhook edge function
 *
 * Handles inbound bank transfer payments via Nomba virtual accounts.
 *
 * GET  — Browser redirect (Nomba sandbox behaviour) — acknowledged only
 * POST — Server-to-server webhook — verified and processed
 *
 * Matching logic:
 *   1. Find terminal by virtual account number (aliasAccountNumber)
 *   2. Match AWAITING_PAYMENT sale by terminal_id + exact amount + 30min window
 *   3. Confirm sale + payment record
 *
 * Source of truth for all payment confirmation.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOMBA_SIGNING_KEY = "NombaHackathon2026";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------
async function verifySignature(
  rawBody: string,
  receivedSignature: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(NOMBA_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(rawBody)
  );
  const computedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer))
  );
  return computedSignature === receivedSignature;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  // GET — Nomba sandbox browser redirect. Just acknowledge.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const orderReference = url.searchParams.get("orderReference") ?? "";
    console.log(`GET callback received | orderReference: ${orderReference}`);
    return new Response("OK", { status: 200 });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const rawBody = await req.text();

  // Verify signature
  const receivedSignature = req.headers.get("nomba-signature") ?? "";
  const isValid = await verifySignature(rawBody, receivedSignature);

  if (!isValid) {
    console.error("Invalid Nomba signature — request rejected");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const eventType: string = payload.event_type ?? payload.eventType ?? "";
  console.log(`Nomba event: ${eventType} | requestId: ${payload.requestId ?? ""}`);

  // Only handle virtual account transfer credits
  if (
    eventType === "payment_success" &&
    payload.data?.transaction?.type === "vact_transfer"
  ) {
    return await handleVirtualAccountPayment(payload);
  }

  // Acknowledge everything else — non-200 causes infinite retries
  return json({ received: true }, 200);
});

// ---------------------------------------------------------------------------
// Handle inbound bank transfer
// ---------------------------------------------------------------------------
async function handleVirtualAccountPayment(payload: any): Promise<Response> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const txn = payload.data.transaction;
  const nombaTransactionId: string = txn.transactionId;
  const virtualAccountNumber: string = txn.aliasAccountNumber;
  const amountInNaira: number = txn.transactionAmount; // Nomba sends Naira
  const amountInKobo: number = Math.round(amountInNaira * 100);
  const paidAt: string = txn.time ?? new Date().toISOString();

  // 1. Idempotency — already processed?
  const { data: existingPayment } = await supabase
    .from("payments")
    .select("id, status")
    .eq("provider_reference", nombaTransactionId)
    .maybeSingle();

  if (existingPayment && existingPayment.status === "SUCCESSFUL") {
    console.log(`Already processed ${nombaTransactionId} — skipping`);
    return json({ received: true, idempotent: true }, 200);
  }

  // 2. Find terminal by virtual account number
  const { data: terminal, error: terminalError } = await supabase
    .from("terminals")
    .select("id, branch_id, business_id")
    .eq("nomba_virtual_account_number", virtualAccountNumber)
    .eq("is_active", true)
    .maybeSingle();

  if (terminalError || !terminal) {
    console.error(`No active terminal for virtual account ${virtualAccountNumber}`);
    // 200 — don't retry for unknown accounts
    return json({ received: true, warning: "unknown_terminal" }, 200);
  }

  // 3. Match AWAITING_PAYMENT sale by terminal + exact amount + 30min window
  //    Scoping to a single terminal makes amount matching reliable —
  //    concurrent pending sales on one terminal is almost always 1.
  const windowStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: sale, error: saleError } = await supabase
    .from("sales")
    .select("id, payment_id, payment_reference")
    .eq("terminal_id", terminal.id)
    .eq("business_id", terminal.business_id)
    .eq("total_amount", amountInKobo)
    .eq("payment_status", "AWAITING_PAYMENT")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (saleError || !sale) {
    console.warn(
      `No matching sale on terminal ${terminal.id} | ` +
      `amount: ₦${amountInNaira} | txn: ${nombaTransactionId}`
    );
    return json({ received: true, warning: "no_matching_sale" }, 200);
  }

  // 4. Update or create Payment record
  let paymentId = sale.payment_id;

  if (paymentId) {
    // Payment record already exists (created when cashier initiated transfer)
    await supabase
      .from("payments")
      .update({
        status: "SUCCESSFUL",
        provider_reference: nombaTransactionId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentId);
  } else {
    // No payment record yet — create one now
    paymentId = crypto.randomUUID();
    await supabase
      .from("payments")
      .insert({
        id: paymentId,
        sale_id: sale.id,
        business_id: terminal.business_id,
        provider: "NOMBA",
        status: "SUCCESSFUL",
        amount: amountInKobo,
        currency: "NGN",
        provider_reference: nombaTransactionId,
        payment_method: "TRANSFER",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
  }

  // 5. Confirm the sale
  const { error: saleUpdateError } = await supabase
    .from("sales")
    .update({
      payment_status: "COMPLETED",
      status: "COMPLETED",
      amount_paid: amountInKobo,
      payment_id: paymentId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sale.id)
    .eq("business_id", terminal.business_id);

  if (saleUpdateError) {
    console.error("Failed to confirm sale:", saleUpdateError);
    // Return 500 — want Nomba to retry this genuine failure
    return json({ error: "Failed to confirm sale" }, 500);
  }

  console.log(
    `✅ Sale ${sale.id} (ref: ${sale.payment_reference}) CONFIRMED | ` +
    `₦${amountInNaira} | terminal: ${terminal.id} | txn: ${nombaTransactionId}`
  );

  return json({
    received: true,
    saleId: sale.id,
    paymentId,
    status: "SUCCESSFUL",
  }, 200);
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
