import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
        .select("id, business_id, status")
        .eq("id", user.id)
        .single();

    if (!staffProfile || staffProfile.status !== "ACTIVE") {
        return json({ error: "Forbidden" }, 403);
    }

    const { saleId, customerId, amount, paymentMethod, notes } = await req.json();

    if (!saleId || !customerId || !amount) {
        return json({ error: "Missing required fields" }, 400);
    }

    const { data, error } = await supabaseAdmin.rpc("record_debt_payment", {
        p_business_id:    staffProfile.business_id,
        p_sale_id:        saleId,
        p_customer_id:    customerId,
        p_staff_id:       staffProfile.id,
        p_amount:         amount,
        p_payment_method: paymentMethod ?? "CASH",
        p_notes:          notes ?? null
    });

    if (error) {
        console.error("record_debt_payment error:", error);
        return json({ error: error.message }, 500);
    }

    return json(data, 200);
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}