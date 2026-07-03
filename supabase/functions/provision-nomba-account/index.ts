/**
 * provision-nomba-account edge function
 *
 * Called once per terminal when admin activates it.
 * Creates a Nomba static virtual account and stores details on the terminal.
 *
 * Request body:
 *   { terminalId: string, businessId: string }
 *
 * Flow:
 *   Validate terminal exists and belongs to business
 *   → Check not already provisioned
 *   → Get Nomba token
 *   → Create static virtual account
 *   → Store account details on terminals row
 *   → Return account details to caller
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNombaToken } from "../_shared/nomba-auth.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: { terminalId: string; businessId: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { terminalId, businessId } = body;
  if (!terminalId || !businessId) {
    return json({ error: "terminalId and businessId are required" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Load terminal — verify it belongs to this business
  const { data: terminal, error: terminalError } = await supabase
    .from("terminals")
    .select("id, branch_id, business_id, name, nomba_virtual_account_number")
    .eq("id", terminalId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (terminalError || !terminal) {
    return json({ error: "Terminal not found" }, 404);
  }

  // 2. Already provisioned — return existing details (idempotent)
  if (terminal.nomba_virtual_account_number) {
    return json({
      message: "Already provisioned",
      accountNumber: terminal.nomba_virtual_account_number,
    }, 200);
  }

  // 3. Load business to get merchant sub-account + name
  const { data: business } = await supabase
    .from("businesses")
    .select("id, name, nomba_sub_account_id, merchant_status, payments_enabled")
    .eq("id", businessId)
    .maybeSingle();

  if (!business) {
    return json({ error: "Business not found" }, 404);
  }

  if (business.merchant_status !== "APPROVED" || !business.payments_enabled) {
    return json({
      error: "Business is not approved for payments",
      code: "MERCHANT_NOT_APPROVED",
    }, 403);
  }

  if (!business.nomba_sub_account_id) {
    return json({
      error: "Business has no Nomba sub-account configured",
      code: "NO_SUB_ACCOUNT",
    }, 403);
  }

  // 4. Get Nomba token
  let nombaToken: { accessToken: string; accountId: string; baseUrl: string };
  try {
    nombaToken = await getNombaToken();
  } catch (err) {
    console.error("Nomba auth failed:", err);
    return json({ error: "Unable to contact payment provider" }, 502);
  }

  // 5. Create static virtual account under the merchant's sub-account
  //    accountRef must be unique — use terminalId
  //    accountName visible to customers making transfers
  const accountName = `${business.name} - ${terminal.name}`.substring(0, 50);
  const accountRef = `zenith-terminal-${terminalId}`;

  let virtualAccount: {
    accountNumber: string;
    bankName: string;
    accountName: string;
  };

  try {
    const nombaRes = await fetch(
      `${nombaToken.baseUrl}/v1/accounts/virtual`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${nombaToken.accessToken}`,
          "Content-Type": "application/json",
          "accountId": business.nomba_sub_account_id, // sub-account creates the virtual account
        },
        body: JSON.stringify({
          accountRef,
          accountName,
          currency: "NGN",
          type: "static",          // permanent — never expires
        }),
      }
    );

    const nombaJson = await nombaRes.json();
    console.log("Nomba virtual account response:", JSON.stringify(nombaJson));

    if (nombaJson.code !== "00") {
      console.error("Nomba virtual account creation failed:", nombaJson);
      return json({
        error: "Failed to create virtual account",
        code: "NOMBA_ERROR",
        details: nombaJson.description,
      }, 502);
    }

    const acct = nombaJson.data;
    virtualAccount = {
      accountNumber: acct.bankAccountNumber ?? acct.accountNumber,
      bankName: acct.bankName ?? acct.bank,
      accountName: acct.bankAccountName ?? acct.accountName,
    };

  } catch (err) {
    console.error("Nomba API call failed:", err);
    return json({ error: "Unable to contact payment provider" }, 502);
  }

  // 6. Store virtual account details on the terminal
  const { error: updateError } = await supabase
    .from("terminals")
    .update({
      nomba_virtual_account_number: virtualAccount.accountNumber,
      nomba_virtual_account_bank: virtualAccount.bankName,
      nomba_virtual_account_name: virtualAccount.accountName,
      nomba_onboarded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", terminalId)
    .eq("business_id", businessId);

  if (updateError) {
    console.error("Failed to save virtual account to terminal:", updateError);
    return json({ error: "Failed to save account details" }, 500);
  }

  console.log(
    `✅ Terminal ${terminalId} provisioned | account: ${virtualAccount.accountNumber} (${virtualAccount.bankName})`
  );

  return json({
    terminalId,
    accountNumber: virtualAccount.accountNumber,
    bankName: virtualAccount.bankName,
    accountName: virtualAccount.accountName,
  }, 200);
});

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
