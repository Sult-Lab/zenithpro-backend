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

    const { data: profile } = await supabaseAdmin
        .from("user_profiles")
        .select("business_id, status")
        .eq("id", user.id)
        .single();

    if (!profile || profile.status !== "ACTIVE") {
        return json({ error: "Forbidden" }, 403);
    }

    const {
        clientId,
        firstName,
        lastName,
        phone,
        email,
        address,
        notes
    } = await req.json();

    if (!clientId || !firstName) {
        return json({ error: "clientId and firstName are required" }, 400);
    }

    const { data, error } = await supabaseAdmin.rpc("upsert_customer", {
        p_client_id:   clientId,
        p_business_id: profile.business_id,
        p_first_name:  firstName,
        p_last_name:   lastName  ?? null,
        p_phone:       phone     ?? null,
        p_email:       email     ?? null,
        p_address:     address   ?? null,
        p_notes:       notes     ?? null
    });

    if (error) {
        console.error("upsert_customer error:", error);
        if (error.message?.includes("unique") || error.code === "23505") {
            return json({ error: "A customer with this phone number already exists" }, 409);
        }
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