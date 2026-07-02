import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });

serve(async (req) => {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const supabaseUser = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { newPassword } = await req.json();
    if (!newPassword || newPassword.length < 6) {
        return json({ error: "Password must be at least 6 characters" }, 400);
    }

    const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error: updateError } =
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
            password: newPassword,
        });

    if (updateError) return json({ error: updateError.message }, 400);

    await supabaseAdmin
        .from("user_profiles")
        .update({ must_change_password: false })
        .eq("id", user.id);

    return json({ success: true });
});