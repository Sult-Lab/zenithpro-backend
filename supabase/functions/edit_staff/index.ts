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

    // Verify requester is ADMIN or MANAGER
    const { data: requester } = await supabaseAdmin
        .from("user_profiles")
        .select("business_id, role, status")
        .eq("id", user.id)
        .single();

    if (!requester || requester.status !== "ACTIVE") {
        return json({ error: "Forbidden" }, 403);
    }
    if (!["ADMIN", "MANAGER"].includes(requester.role)) {
        return json({ error: "Only admins and managers can edit staff" }, 403);
    }

    const {
        staffId,
        firstName,
        lastName,
        phone,
        email,
        role,
        branchId,
        status,
    } = await req.json();

    if (!staffId) return json({ error: "staffId is required" }, 400);
    if (!firstName?.trim()) return json({ error: "First name is required" }, 400);

    // Validate role if provided
    if (role && !["ADMIN", "MANAGER", "STAFF"].includes(role)) {
        return json({ error: "Invalid role" }, 400);
    }

    // Managers cannot promote to ADMIN
    if (requester.role === "MANAGER" && role === "ADMIN") {
        return json({ error: "Managers cannot assign admin role" }, 403);
    }

    // Verify the staff being edited belongs to the same business
    const { data: targetStaff } = await supabaseAdmin
        .from("user_profiles")
        .select("id, business_id, role, email")
        .eq("id", staffId)
        .single();

    if (!targetStaff) {
        return json({ error: "Staff member not found" }, 404);
    }
    if (targetStaff.business_id !== requester.business_id) {
        return json({ error: "Cannot edit staff from another business" }, 403);
    }
    // Prevent editing another ADMIN unless you're also ADMIN
    if (targetStaff.role === "ADMIN" && requester.role !== "ADMIN") {
        return json({ error: "Only admins can edit other admins" }, 403);
    }

    // Validate branchId belongs to this business if provided
    if (branchId) {
        const { data: branch } = await supabaseAdmin
            .from("branches")
            .select("id")
            .eq("id", branchId)
            .eq("business_id", requester.business_id)
            .single();

        if (!branch) return json({ error: "Invalid branch" }, 400);
    }

    // Build update payload
    const updatePayload: Record<string, unknown> = {
        first_name: firstName.trim(),
        last_name:  lastName?.trim() ?? null,
        phone:      phone?.trim() ?? null,
        email:      email?.trim() ?? null,
    };

    if (role)   updatePayload.role      = role;
    if (status) updatePayload.status    = status;

    // branchId can be explicitly null to unassign
    if ("branchId" in req) {
        updatePayload.branch_id = branchId ?? null;
    } else {
        updatePayload.branch_id = branchId ?? null;
    }

    const { data: updated, error: updateError } = await supabaseAdmin
        .from("user_profiles")
        .update(updatePayload)
        .eq("id", staffId)
        .select()
        .single();

    if (updateError) {
        console.error("edit staff error:", updateError);
        return json({ error: updateError.message }, 500);
    }

    // If email changed, update auth.users email too
    if (email && email.trim() !== targetStaff.email) {
        const { error: emailError } = await supabaseAdmin.auth.admin
            .updateUserById(staffId, { email: email.trim() });

        if (emailError) {
            console.warn("Email update failed:", emailError.message);
            // Non-fatal — profile updated, just email auth update failed
        }
    }

    return json({
        staffId:   updated.id,
        firstName: updated.first_name,
        lastName:  updated.last_name,
        phone:     updated.phone,
        email:     updated.email,
        role:      updated.role,
        branchId:  updated.branch_id,
        status:    updated.status,
    }, 200);
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}