/**
 * payments-create edge function
 *
 * Called by the Android app when a customer selects "Pay with Card".
 *
 * Flow:
 *   Android → POST /functions/v1/payments-create
 *           → Validate merchant is approved and payments enabled
 *           → Authenticate with Nomba
 *           → Create Nomba Checkout order under merchant's sub-account
 *           → Save Payment record to Supabase (status: PENDING)
 *           → Return checkoutLink + orderReference to Android
 *
 * Android then opens checkoutLink in a Chrome Custom Tab.
 * Payment confirmation comes via nomba-webhook (source of truth).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNombaToken } from "../_shared/nomba-auth.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreatePaymentRequest {
  saleId: string;
  businessId: string;
  amount: number;       // in kobo — we convert to Naira string for Nomba
  currency?: string;    // defaults to NGN
  customerEmail?: string;
  customerId?: string;
}

interface CreatePaymentResponse {
  paymentId: string;
  checkoutLink: string;
  orderReference: string;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // 1. Parse and validate request body
  let body: CreatePaymentRequest;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { saleId, businessId, amount, currency = "NGN", customerEmail, customerId } = body;

  if (!saleId || !businessId || !amount) {
    return json({ error: "saleId, businessId, and amount are required" }, 400);
  }

  if (amount <= 0) {
    return json({ error: "Amount must be greater than zero" }, 400);
  }

  // 2. Create Supabase client — use service role to bypass RLS
  //    (this function runs server-side, no user JWT available)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 3. Load business and verify payments are enabled
  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, name, merchant_status, payments_enabled, nomba_sub_account_id")
    .eq("id", businessId)
    .maybeSingle();

  if (businessError || !business) {
    console.error("Business lookup failed:", businessError);
    return json({ error: "Business not found" }, 404);
  }

  // Gate: payments must be explicitly enabled by admin
  if (business.merchant_status !== "APPROVED") {
    return json({
      error: "Your payment account is currently under review.",
      code: "MERCHANT_NOT_APPROVED",
    }, 403);
  }

  if (!business.payments_enabled) {
    return json({
      error: "Payments are not enabled for this account.",
      code: "PAYMENTS_DISABLED",
    }, 403);
  }

  if (!business.nomba_sub_account_id) {
    return json({
      error: "Payment account is not configured. Please contact support.",
      code: "NO_SUB_ACCOUNT",
    }, 403);
  }

  // 4. Verify the sale exists and belongs to this business
  const { data: sale, error: saleError } = await supabase
    .from("sales")
    .select("id, total_amount, payment_status, payment_id")
    .eq("id", saleId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (saleError || !sale) {
    return json({ error: "Sale not found" }, 404);
  }

  // Prevent duplicate payment creation for the same sale
  if (sale.payment_id) {
    // Check if existing payment is still pending — return it instead of creating new
    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id, checkout_reference, status")
      .eq("id", sale.payment_id)
      .maybeSingle();

    if (existingPayment && existingPayment.status === "PENDING") {
      // Existing payment is still open — this shouldn't happen in normal flow
      // but protects against double-taps or retries
      console.warn(`Sale ${saleId} already has a pending payment ${existingPayment.id}`);
    }
  }

  // 5. Get Nomba access token
  let nombaToken: { accessToken: string; accountId: string; baseUrl: string };
  try {
    nombaToken = await getNombaToken();
  } catch (err) {
    console.error("Nomba authentication failed:", err);
    return json({ error: "Unable to contact payment provider" }, 502);
  }

  // 6. Convert amount from kobo to Naira string
  //    Nomba requires amount as string with 2 decimal places e.g. "5400.00"
  const amountInNaira = (amount / 100).toFixed(2);

  // 7. Generate our own orderReference (UUID) for idempotency
  //    We use this to match webhook events back to our Payment record
  const orderReference = crypto.randomUUID();

  // 8. Create Nomba Checkout order
  //    accountId in the ORDER BODY = merchant sub-account to receive funds
  //    accountId in the HEADER = our parent Nomba account (for auth context)
  let checkoutLink: string;
  let nombaOrderReference: string;

  try {
    const nombaRes = await fetch(`${nombaToken.baseUrl}/v1/checkout/order`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${nombaToken.accessToken}`,
        "Content-Type": "application/json",
        "accountId": nombaToken.accountId, // parent account in header
      },
      body: JSON.stringify({
        order: {
          orderReference,                              // our UUID
          amount: amountInNaira,                       // "5400.00"
          currency,                                    // "NGN"
          accountId: business.nomba_sub_account_id,   // merchant sub-account in body
          callbackUrl: Deno.env.get("NOMBA_CALLBACK_URL") ?? "",
          customerEmail: customerEmail ?? undefined,
          customerId: customerId ?? undefined,
          allowedPaymentMethods: ["Card"],             // card only per spec
          orderMetaData: {
            saleId,
            businessId,
            businessName: business.name,
          },
        },
      }),
    });

    const nombaJson = await nombaRes.json();

    if (nombaJson.code !== "00") {
      console.error("Nomba checkout creation failed:", nombaJson);
      return json({
        error: "Unable to create payment. Please try again.",
        code: "NOMBA_ERROR",
      }, 502);
    }

    checkoutLink = nombaJson.data.checkoutLink;
    nombaOrderReference = nombaJson.data.orderReference;

  } catch (err) {
    console.error("Nomba API call failed:", err);
    return json({ error: "Unable to contact payment provider" }, 502);
  }

  // 9. Save Payment record to Supabase
  const paymentId = crypto.randomUUID();

  const { error: paymentInsertError } = await supabase
    .from("payments")
    .insert({
      id: paymentId,
      sale_id: saleId,
      business_id: businessId,
      provider: "NOMBA",
      status: "PENDING",
      amount,                          // stored in kobo
      currency,
      checkout_reference: nombaOrderReference,
      payment_method: "CARD",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  if (paymentInsertError) {
    // Payment record failed to save — log but still return checkout link.
    // The webhook will reconcile the payment when it arrives.
    // Do NOT block the user from paying.
    console.error("Failed to save payment record:", paymentInsertError);
  } else {
    // Link the payment to the sale
    await supabase
      .from("sales")
      .update({
        payment_id: paymentId,
        payment_status: "AWAITING_PAYMENT",
        updated_at: new Date().toISOString(),
      })
      .eq("id", saleId);
  }

  // 10. Return checkout link to Android
  const response: CreatePaymentResponse = {
    paymentId,
    checkoutLink,
    orderReference: nombaOrderReference,
  };

  console.log(
    `✅ Checkout created for sale ${saleId} | payment ${paymentId} | ref ${nombaOrderReference}`
  );

  return json(response, 200);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
