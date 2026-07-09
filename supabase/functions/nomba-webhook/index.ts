import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NOMBA_SIGNING_KEY = "NombaHackathon2026";

// ---------------------------------------------------------------------------
// Signature verification
// Nomba does NOT sign the raw body.
// They construct a specific string from payload fields + nomba-timestamp header
// then sign that with HMAC-SHA256 + Base64 encode.
//
// Format:
// eventType:requestId:userId:walletId:transactionId:type:time:responseCode:nombaTimestamp
// ---------------------------------------------------------------------------
async function verifySignature(
  payload: any,
  receivedSignature: string,
  nombaTimestamp: string
): Promise<boolean> {
  const merchant    = payload.data?.merchant    ?? {};
  const transaction = payload.data?.transaction ?? {};

  const eventType            = payload.event_type               ?? "";
  const requestId            = payload.requestId                ?? "";
  const userId               = merchant.userId                  ?? "";
  const walletId             = merchant.walletId                ?? "";
  const transactionId        = transaction.transactionId        ?? "";
  const transactionType      = transaction.type                 ?? "";
  const transactionTime      = transaction.time                 ?? "";
  let   responseCode         = transaction.responseCode         ?? "";

  // Nomba treats the string "null" as empty
  if (responseCode === "null") responseCode = "";

  const hashingPayload = [
    eventType,
    requestId,
    userId,
    walletId,
    transactionId,
    transactionType,
    transactionTime,
    responseCode,
    nombaTimestamp,
  ].join(":");

  console.log("Hashing payload:", hashingPayload);

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
    encoder.encode(hashingPayload)
  );

  const computedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer))
  );

  console.log("Computed signature:", computedSignature);
  console.log("Received signature:", receivedSignature);

  return computedSignature === receivedSignature;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    const url = new URL(req.url);
    console.log(`GET callback | ref: ${url.searchParams.get("orderReference")}`);
    return new Response("OK", { status: 200 });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const rawBody = await req.text();

  // Parse payload first — needed for signature verification
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Get Nomba-specific headers
  const receivedSignature = req.headers.get("nomba-signature")
    ?? req.headers.get("nomba-sig-value")
    ?? "";
  const nombaTimestamp = req.headers.get("nomba-timestamp") ?? "";

  console.log("nomba-signature:", receivedSignature);
  console.log("nomba-timestamp:", nombaTimestamp);

  // Verify signature
  const isValid = await verifySignature(payload, receivedSignature, nombaTimestamp);

  if (!isValid) {
    console.error("Invalid Nomba signature — request rejected");
    return new Response("Unauthorized", { status: 401 });
  }

  const eventType: string = payload.event_type ?? "";
  console.log(`Nomba event: ${eventType} | requestId: ${payload.requestId ?? ""}`);

  if (
    eventType === "payment_success" &&
    payload.data?.transaction?.type === "vact_transfer"
  ) {
    return await handleVirtualAccountPayment(payload);
  }

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
  const nombaTransactionId: string  = txn.transactionId;
  const virtualAccountNumber: string = txn.aliasAccountNumber;
  const amountInNaira: number        = txn.transactionAmount;
  const paidAt: string               = txn.time ?? new Date().toISOString();
  const senderName: string           = payload.data.customer?.senderName ?? "Unknown Sender";
  const bankName: string             = payload.data.customer?.bankName ?? "Unknown Bank";

  // 1. Find terminal by virtual account number
  const { data: terminal } = await supabase
    .from("terminals")
    .select("id, business_id, name, fcm_token")
    .eq("nomba_virtual_account_number", virtualAccountNumber)
    .eq("is_active", true)
    .maybeSingle();

  if (!terminal) {
    console.error(`No terminal for virtual account ${virtualAccountNumber}`);
    return json({ received: true, warning: "unknown_terminal" }, 200);
  }

  await supabase.from("nomba_transactions").upsert({
  id: nombaTransactionId,
  terminal_id: terminal.id,
  business_id: terminal.business_id,
  amount: Math.round(amountInNaira * 100),
  sender_name: senderName,
  bank_name: bankName,
  virtual_account_number: virtualAccountNumber,
  narration: txn.narration ?? "",
  paid_at: paidAt,
  created_at: new Date().toISOString(),
}, { onConflict: "id", ignoreDuplicates: true });

  // 3. Send FCM push notification to terminal
  if (terminal.fcm_token) {
    await sendFcmNotification(
      terminal.fcm_token,
      amountInNaira,
      senderName,
      bankName,
    );
  } else {
    console.warn(`Terminal ${terminal.id} has no FCM token registered`);
  }

  console.log(
    `✅ Webhook processed | ₦${amountInNaira} from ${senderName} | ` +
    `terminal: ${terminal.id} | FCM sent: ${!!terminal.fcm_token}`
  );

  return json({ received: true }, 200);
}

async function sendFcmNotification(
  fcmToken: string,
  amountInNaira: number,
  senderName: string,
  bankName: string,
): Promise<void> {
  const serviceAccountJson = Deno.env.get("FCM_SERVICE_ACCOUNT");
  const projectId          = Deno.env.get("FCM_PROJECT_ID");

  if (!serviceAccountJson || !projectId) {
    console.error("FCM_SERVICE_ACCOUNT or FCM_PROJECT_ID not set");
    return;
  }

  // 1. Get OAuth2 access token from service account
  const accessToken = await getFcmAccessToken(serviceAccountJson);
  if (!accessToken) return;

  const formatted = new Intl.NumberFormat("en-NG").format(amountInNaira);

  // 2. Send via FCM HTTP v1 API
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: {
            title: "Payment Received ✅",
            body: `₦${formatted} from ${senderName} (${bankName})`,
          },
          data: {
            title:  "Payment Received ✅",
            body:   `₦${formatted} from ${senderName}`,
            amount: amountInNaira.toString(),
            sender: senderName,
            bank:   bankName,
            type:   "payment_received",
          },
          android: {
            priority: "high",
            notification: {
              channel_id: "nomba_payments",
              sound: "default",
            },
          },
        },
      }),
    }
  );

  const result = await res.json();
  if (res.ok) {
    console.log("FCM v1 sent successfully:", result.name);
  } else {
    console.error("FCM v1 failed:", JSON.stringify(result));
  }
}

async function getFcmAccessToken(
  serviceAccountJson: string
): Promise<string | null> {
  try {
    const sa = JSON.parse(serviceAccountJson);

    // Build JWT for Google OAuth2
    const now     = Math.floor(Date.now() / 1000);
    const expiry  = now + 3600;
    const scope   = "https://www.googleapis.com/auth/firebase.messaging";

    const header  = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: sa.token_uri,
      iat: now,
      exp: expiry,
      scope,
    };

    const encode = (obj: object) =>
      btoa(JSON.stringify(obj))
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

    const signingInput = `${encode(header)}.${encode(payload)}`;

    // Import private key
    const pemKey = sa.private_key
      .replace("-----BEGIN RSA PRIVATE KEY-----", "")
      .replace("-----END RSA PRIVATE KEY-----", "")
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s/g, "");

    const keyBuffer = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signingInput)
    );

    const signatureB64 = btoa(
      String.fromCharCode(...new Uint8Array(signature))
    ).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

    const jwt = `${signingInput}.${signatureB64}`;

    // Exchange JWT for access token
    const tokenRes = await fetch(sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion:  jwt,
      }),
    });

    const tokenData = await tokenRes.json();
    return tokenData.access_token ?? null;

  } catch (err) {
    console.error("Failed to get FCM access token:", err);
    return null;
  }
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