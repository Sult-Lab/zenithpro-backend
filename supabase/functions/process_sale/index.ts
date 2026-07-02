import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// process-sale/index.ts
serve(async (req) => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabaseUser = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: staffProfile } = await supabaseAdmin
        .from("user_profiles")
        .select("id, business_id, role, status, branch_id")
        .eq("id", user.id)
        .single();

    if (!staffProfile || staffProfile.status !== "ACTIVE") {
        return json({ error: "Forbidden" }, 403);
    }

    const body = await req.json();
    const {
        clientTransactionId,
        branchId,     
        terminalId,   
        customerId,
        items,
        subtotal,
        discountAmount,
        taxAmount,
        totalAmount,
        amountPaid,
        changeAmount,
        paymentMethod,
        paymentReference,
        notes
    } = body;

    // Branch resolution:
    // 1. Staff with assigned branch → always use their branch
    // 2. Admin/Manager → use branchId from request (they can pick)
    // 3. Staff with no branch + no branchId → reject
    const resolvedBranchId: string | null = (() => {
        if (staffProfile.branch_id) {
            // Staff is assigned to a branch — always use it
            return staffProfile.branch_id;
        }
        if (["ADMIN", "MANAGER"].includes(staffProfile.role)) {
            // Admin/Manager can specify a branch or leave null
            return branchId ?? null;
        }
        // Staff with no branch assignment — require branchId from client
        return branchId ?? null;
    })();

    // Businesses with branches must have a branch on every sale
    // Check if this business has any branches
    const { count: branchCount } = await supabaseAdmin
    .from("branches")
    .select("id", { count: "exact", head: true })
    .eq("business_id", staffProfile.business_id)
    .eq("is_active", true)
    .is("deleted_at", null);

    if (branchCount && branchCount > 0 && !resolvedBranchId) {
        return json({
            error: "A branch must be selected for this sale"
        }, 400);
    }

    if (!clientTransactionId || !items?.length || totalAmount == null) {
        return json({ error: "Missing required fields" }, 400);
    }

    if (!["CASH","CARD","TRANSFER","SPLIT","DEBT"].includes(paymentMethod)) {
        return json({ error: "Invalid payment method" }, 400);
    }

    if (paymentMethod === "DEBT" && !customerId) {
        return json({ error: "Customer required for debt sales" }, 400);
    }

    const isNombaTransfer = paymentMethod === "TRANSFER";
    const paymentStatus   = isNombaTransfer ? "AWAITING_PAYMENT" : "COMPLETED";

    const { data, error } = await supabaseAdmin.rpc("process_sale", {
        p_client_transaction_id: clientTransactionId,
        p_business_id:           staffProfile.business_id,
        p_branch_id:             resolvedBranchId,
        p_terminal_id:           terminalId ?? null,
        p_staff_id:              staffProfile.id,
        p_customer_id:           customerId ?? null,
        p_items:                 items,
        p_subtotal:              subtotal,
        p_discount_amount:       discountAmount ?? 0,
        p_tax_amount:            taxAmount ?? 0,
        p_total_amount:          totalAmount,
        p_amount_paid:           amountPaid,
        p_change_amount:         changeAmount ?? 0,
        p_payment_method:        paymentMethod,
        p_payment_reference:     paymentReference ?? null,
        p_payment_status:        paymentStatus,
        p_notes:                 notes ?? null
    });

    if (error) {
        console.error("process_sale error:", error);
        if (error.message?.includes("Insufficient stock")) {
            return json({ error: error.message }, 422);
        }
        return json({ error: error.message }, 500);
    }

    let virtualAccount = null;
    if (isNombaTransfer && terminalId) {
    const { data: terminal } = await supabaseAdmin
        .from("terminals")
        .select("nomba_virtual_account_number, nomba_virtual_account_bank, nomba_virtual_account_name")
        .eq("id", terminalId)
        .single();
    virtualAccount = terminal;
}

    return json({
        ...data,
        branchId:             resolvedBranchId,
        paymentReference:     paymentReference ?? null,
        paymentStatus,
        virtualAccountNumber: virtualAccount?.nomba_virtual_account_number ?? null,
        virtualAccountBank:   virtualAccount?.nomba_virtual_account_bank ?? null,
        virtualAccountName:   virtualAccount?.nomba_virtual_account_name ?? null,
        }, 200);
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}