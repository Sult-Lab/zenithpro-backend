import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const { email, password } = await req.json();

    if (!email || !password) {
        return json({ error: "Email and password are required" }, 400);
    }

    // Sign in with Supabase Auth
    const supabaseAnon = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!
    );

    const { data: authData, error: authError } =
        await supabaseAnon.auth.signInWithPassword({ email, password });

    if (authError || !authData.user || !authData.session) {
        return json({ error: authError?.message ?? "Invalid credentials" }, 401);
    }

    // Use service role to fetch profile + business without RLS issues
    const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch user profile
    const { data: profile, error: profileError } = await supabaseAdmin
        .from("user_profiles")
        .select("id, business_id, first_name, last_name, role, status, must_change_password")
        .eq("id", authData.user.id)
        .single();

    if (profileError || !profile) {
        return json({ error: "User profile not found" }, 404);
    }

    if (profile.status !== "ACTIVE") {
        return json({ error: "Account is inactive. Contact your administrator." }, 403);
    }

    // Fetch business
    const { data: business, error: businessError } = await supabaseAdmin
        .from("businesses")
        .select("id, name, phone, address")
        .eq("id", profile.business_id)
        .single();

    if (businessError || !business) {
        return json({ error: "Business not found" }, 404);
    }

    // Fetch business settings for currency etc.
    const { data: settings } = await supabaseAdmin
        .from("business_settings")
        .select("currency_symbol, currency_code, tax_rate, allow_negative_stock, require_customer_sale, low_stock_threshold")
        .eq("business_id", profile.business_id)
        .maybeSingle();

    return json({
        accessToken:  authData.session.access_token,
        refreshToken: authData.session.refresh_token,
        expiresAt:    authData.session.expires_at,
        user: {
            id:                 authData.user.id,
            email:              authData.user.email,
            firstName:          profile.first_name,
            lastName:           profile.last_name,
            role:               profile.role,
            mustChangePassword: profile.must_change_password ?? false
        },
        business: {
            id:      business.id,
            name:    business.name,
            phone:   business.phone,
            address: business.address
        },
        settings: settings ?? {
            currencySymbol:     "₦",
            currencyCode:       "NGN",
            taxRate:            0,
            allowNegativeStock: false,
            requireCustomerSale: false,
            lowStockThreshold:  5
        }
    }, 200);
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}