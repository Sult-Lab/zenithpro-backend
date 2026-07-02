import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    // Verify the requesting user is ADMIN or MANAGER
    const supabaseUser = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } =
        await supabaseUser.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch requesting user's profile to verify role and get businessId
    const { data: requesterProfile, error: profileError } =
        await supabaseAdmin
            .from("user_profiles")
            .select("business_id, role, status")
            .eq("id", user.id)
            .single();

    if (profileError || !requesterProfile) {
        return json({ error: "Profile not found" }, 404);
    }
    if (requesterProfile.status !== "ACTIVE") {
        return json({ error: "Account inactive" }, 403);
    }
    if (!["ADMIN", "MANAGER"].includes(requesterProfile.role)) {
        return json({ error: "Only admins and managers can create staff" }, 403);
    }

    const {
        email,
        password,
        firstName,
        lastName,
        phone,
        role,
        branchId,
    } = await req.json();

    // Validate
    if (!email || !password || !firstName || !role) {
        return json({
            error: "email, password, firstName and role are required"
        }, 400);
    }
    if (!["ADMIN", "MANAGER", "STAFF"].includes(role)) {
        return json({ error: "Invalid role" }, 400);
    }
    // Managers cannot create admins
    if (requesterProfile.role === "MANAGER" && role === "ADMIN") {
        return json({ error: "Managers cannot create admin accounts" }, 403);
    }
    if (password.length < 6) {
        return json({ error: "Password must be at least 6 characters" }, 400);
    }

    // Check if email already exists in this business
    const { data: existing } = await supabaseAdmin
        .from("user_profiles")
        .select("id")
        .eq("business_id", requesterProfile.business_id)
        .limit(1);

    // Create auth user
    const { data: authData, error: authError } =
        await supabaseAdmin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,   // auto-confirm so they can login immediately
            user_metadata: {
                first_name: firstName,
                last_name:  lastName ?? ""
            }
        });

    if (authError || !authData.user) {
        console.error("Auth creation error:", authError);
        if (authError?.message?.includes("already registered")) {
            return json({ error: "A user with this email already exists" }, 409);
        }
        return json({ error: authError?.message ?? "Failed to create user" }, 400);
    }

    // Create user profile
    const { error: profileInsertError } = await supabaseAdmin
        .from("user_profiles")
        .insert({
            id:                   authData.user.id,
            business_id:          requesterProfile.business_id,
            first_name:           firstName,
            last_name:            lastName ?? null,
            phone:                phone ?? null,
            email:                email,
            role,
            branch_id:            branchId ?? null,
            status:               "ACTIVE",
            must_change_password: true,   // force password change on first login
        });

    if (profileInsertError) {
        // Roll back auth user if profile creation fails
        await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
        console.error("Profile insert error:", profileInsertError);
        return json({ error: profileInsertError.message }, 400);
    }

    return json({
        staffId:   authData.user.id,
        email:     authData.user.email,
        firstName,
        lastName,
        role,
        branchId:  branchId ?? null,
        message:   "Staff account created. They can now login with the provided credentials."
    }, 201);
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}