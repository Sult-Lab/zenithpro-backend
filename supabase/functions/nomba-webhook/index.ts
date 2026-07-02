import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOMBA_SIGNING_KEY = "NombaHackathon2026";

// ---------------------------------------------------------------------------
// Signature verification
// Nomba signs the raw request body with HMAC-SHA256 using your signing key.
// Compare against the `nomba-signature` header (Base64-encoded).
// CRITICAL: sign the raw body bytes — never parse JSON first.
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
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();

  // 1. Verify signature — reject anything that doesn't check out
  const receivedSignature = req.headers.get("nomba-signature") ?? "";
  const isValid = await verifySignature(rawBody, receivedSignature);

  if (!isValid) {
    console.error("Invalid Nomba signature — request rejected");
    return new Response("Unauthorized", { status: 401 });
  }

  // 2. Parse payload
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType: string = payload.event_type;
  const requestId: string = payload.requestId;

  console.log(`Received Nomba event: ${eventType} | requestId: ${requestId}`);

  // 3. Only act on virtual account transfer payments
  if (
    eventType === "payment_success" &&
    payload.data?.transaction?.type === "vact_transfer"
  ) {
    return await handleVirtualAccountPayment(payload);
  }

  // Acknowledge all other events — returning non-200 causes infinite retries
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// ---------------------------------------------------------------------------
// Handle inbound virtual account payment
// ---------------------------------------------------------------------------
async function handleVirtualAccountPayment(payload: any): Promise<Response> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // bypasses RLS — needed for webhook context
  );

  const transaction = payload.data.transaction;
  const nombaTransactionId: string = transaction.transactionId;
  const virtualAccountNumber: string = transaction.aliasAccountNumber;
  const amountInNaira: number = transaction.transactionAmount; // Nomba sends Naira
  const amountInKobo: number = Math.round(amountInNaira * 100);
  const paidAt: string = transaction.time;

  // 4. Idempotency — bail early if already processed
  const { data: existingSale } = await supabase
    .from("sales")
    .select("id")
    .eq("nomba_payment_reference", nombaTransactionId)
    .maybeSingle();

  if (existingSale) {
    console.log(`Already processed ${nombaTransactionId} — skipping`);
    return new Response(JSON.stringify({ received: true, idempotent: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 5. Look up which terminal owns this virtual account number
  //    Terminal → branch_id + business_id for sale scoping
  const { data: terminal, error: terminalError } = await supabase
    .from("terminals")
    .select("id, branch_id, business_id")
    .eq("nomba_virtual_account_number", virtualAccountNumber)
    .eq("is_active", true)
    .maybeSingle();

  if (terminalError || !terminal) {
    // Virtual account not mapped to any active terminal — log and acknowledge.
    // Do NOT return 5xx here — Nomba would retry forever for an unknown account.
    console.error(
      `No active terminal found for virtual account ${virtualAccountNumber}`
    );
    return new Response(
      JSON.stringify({ received: true, warning: "unknown_terminal" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  const { id: terminalId, branch_id: branchId, business_id: businessId } = terminal;

  // 6. Match sale by terminal + exact amount + recency
  //
  //    Why this works reliably:
  //    - Scoped to one physical terminal (tiny concurrent sale pool)
  //    - Exact amount match (use kobo padding at checkout to guarantee uniqueness)
  //    - 30-minute window eliminates stale matches
  //    - Order by created_at DESC so the most recent match wins
  const windowStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: matchedSale, error: saleError } = await supabase
    .from("sales")
    .select("id, payment_reference")
    .eq("terminal_id", terminalId)
    .eq("business_id", businessId)
    .eq("total_amount", amountInKobo)
    .eq("payment_status", "AWAITING_PAYMENT")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (saleError || !matchedSale) {
    // Payment received but no matching pending sale on this terminal.
    // Could be: customer paid wrong amount, sale already expired, manual top-up.
    // Log for manual investigation — do not auto-create a sale.
    console.warn(
      `No matching AWAITING_PAYMENT sale on terminal ${terminalId}. ` +
        `Amount: ₦${amountInNaira}, Nomba txn: ${nombaTransactionId}`
    );
    return new Response(
      JSON.stringify({ received: true, warning: "no_matching_sale" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 7. Confirm the sale
  const { error: updateError } = await supabase
    .from("sales")
    .update({
      payment_status: "COMPLETED",
      status: "COMPLETED",
      amount_paid: amountInKobo,
      nomba_payment_reference: nombaTransactionId,
      payment_confirmed_at: paidAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", matchedSale.id)
    .eq("business_id", businessId); // belt-and-suspenders ownership check

  if (updateError) {
    console.error(
      `Failed to confirm sale ${matchedSale.id}:`,
      updateError
    );
    // Return 500 here — this IS a genuine failure we want Nomba to retry
    return new Response(
      JSON.stringify({ error: "Failed to confirm sale" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(
    `✅ Sale ${matchedSale.id} (ref: ${matchedSale.payment_reference}) confirmed` +
      ` via Nomba txn ${nombaTransactionId} on terminal ${terminalId}`
  );

  return new Response(
    JSON.stringify({
      received: true,
      saleId: matchedSale.id,
      paymentReference: matchedSale.payment_reference,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
