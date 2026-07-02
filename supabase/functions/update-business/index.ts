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

    // Only ADMIN can update business profile
    const { data: profile } = await supabaseAdmin
        .from("user_profiles")
        .select("business_id, role, status")
        .eq("id", user.id)
        .single();

    if (!profile || profile.status !== "ACTIVE") {
        return json({ error: "Forbidden" }, 403);
    }
    if (profile.role !== "ADMIN") {
        return json({ error: "Only admins can edit business profile" }, 403);
    }

    const {
        name,
        type,
        phone,
        email,
        address,
        logoUrl,
        currencyCode,
        currencySymbol,
    } = await req.json();

    if (!name?.trim()) {
        return json({ error: "Business name is required" }, 400);
    }

    // Validate currency code
    const validCurrencies = [
        "NGN", "USD", "GBP", "EUR", "GHS", "KES",
        "ZAR", "TZS", "UGX", "XOF", "RWF", "ETB"
    ];
    if (currencyCode && !validCurrencies.includes(currencyCode)) {
        return json({ error: "Invalid currency code" }, 400);
    }

    const { data: business, error: updateError } = await supabaseAdmin
        .from("businesses")
        .update({
            name:            name.trim(),
            type:            type?.trim() ?? null,
            phone:           phone?.trim() ?? null,
            email:           email?.trim() ?? null,
            address:         address?.trim() ?? null,
            logo_url:        logoUrl ?? null,
            currency_code:   currencyCode ?? "NGN",
            currency_symbol: currencySymbol ?? "₦",
            updated_at:      new Date().toISOString()
        })
        .eq("id", profile.business_id)
        .select()
        .single();

    if (updateError) {
        console.error("update business error:", updateError);
        return json({ error: updateError.message }, 500);
    }

    // Also update business_settings currency to keep in sync
    await supabaseAdmin
        .from("business_settings")
        .update({
            currency_code:   currencyCode ?? "NGN",
            currency_symbol: currencySymbol ?? "₦",
        })
        .eq("business_id", profile.business_id);

    return json({
        businessId:     business.id,
        name:           business.name,
        type:           business.type,
        phone:          business.phone,
        email:          business.email,
        address:        business.address,
        logoUrl:        business.logo_url,
        currencyCode:   business.currency_code,
        currencySymbol: business.currency_symbol,
        updatedAt:      business.updated_at
    }, 200);
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}