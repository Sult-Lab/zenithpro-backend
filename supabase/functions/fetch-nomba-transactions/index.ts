import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getNombaToken } from "../_shared/nomba-auth.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: { businessId: string; terminalId: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { businessId, terminalId } = body;
  if (!businessId || !terminalId) {
    return json({ error: "businessId and terminalId are required" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Load this specific terminal
  const { data: terminal, error: terminalError } = await supabase
    .from("terminals")
    .select("id, name, nomba_virtual_account_number")
    .eq("id", terminalId)
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();

  if (terminalError || !terminal) {
    return json({ error: "Terminal not found" }, 404);
  }

  if (!terminal.nomba_virtual_account_number) {
    return json({
      error: "Terminal has no virtual account provisioned",
      code: "NOT_PROVISIONED",
    }, 400);
  }

  // 2. Get Nomba token
  let nombaToken: { accessToken: string; accountId: string; baseUrl: string };
  try {
    nombaToken = await getNombaToken();
  } catch (err) {
    console.error("Nomba auth failed:", err);
    return json({ error: "Unable to contact payment provider" }, 502);
  }

  // 3. Fetch transactions for this terminal's virtual account
  let allTransactions: any[] = [];

  try {
    const url = new URL(`${nombaToken.baseUrl}/v1/transactions/virtual`);
    url.searchParams.set("virtual_account", terminal.nomba_virtual_account_number);
    url.searchParams.set("limit", "100");

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${nombaToken.accessToken}`,
        "Content-Type": "application/json",
        "accountId": nombaToken.accountId,
      },
    });

    const nombaJson = await res.json();
    console.log("Nomba response code:", nombaJson.code);

    if (nombaJson.code === "00" && nombaJson.data?.results) {
      allTransactions = nombaJson.data.results.map((t: any) => ({
        id:                   t.id ?? t.transactionId,
        terminalId:           terminal.id,
        terminalName:         terminal.name,
        virtualAccountNumber: terminal.nomba_virtual_account_number,
        amount:               Math.round(parseFloat(t.amount ?? t.transactionAmount ?? "0") * 100),
        senderName:           t.senderName ?? t.ktaSenderName ?? "Unknown Sender",
        bankName:             t.bankName ?? t.senderBankName ?? "Unknown Bank",
        narration:            t.narration ?? "",
        status:               t.status ?? "SUCCESS",
        timeCreated:          t.timeCreated ?? t.time ?? new Date().toISOString(),
        sessionId:            t.sessionId ?? "",
      }));
    } else {
      console.warn("Nomba returned no results:", JSON.stringify(nombaJson));
    }
  } catch (err) {
    console.error("Nomba API call failed:", err);
    return json({ error: "Failed to fetch transactions from Nomba" }, 502);
  }

  // 4. Sort newest first
  allTransactions.sort((a, b) =>
    new Date(b.timeCreated).getTime() - new Date(a.timeCreated).getTime()
  );

  // 5. Merge confirmed status from local DB
  const nombaIds = allTransactions.map(t => t.id).filter(Boolean);
  let confirmedIds = new Set<string>();

  if (nombaIds.length > 0) {
    const { data: confirmedRows } = await supabase
      .from("nomba_transactions")
      .select("id")
      .in("id", nombaIds)
      .eq("confirmed", true);

    confirmedIds = new Set((confirmedRows ?? []).map((r: any) => r.id));
  }

  const results = allTransactions.map(t => ({
    ...t,
    confirmed: confirmedIds.has(t.id),
  }));

  console.log(
    `✅ Fetched ${results.length} transactions for terminal ${terminal.id} ` +
    `(${terminal.nomba_virtual_account_number})`
  );

  return json({ results, terminalName: terminal.name }, 200);
});

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}