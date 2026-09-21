import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // Verify the caller is authenticated
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Unauthorized" }, 401);

  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) return json({ error: "Invalid token" }, 401);

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Delete all business data via stored procedure
  const { data, error: rpcError } = await supabaseAdmin.rpc(
    "delete_business_and_all_data",
    { p_user_id: user.id }
  );

  if (rpcError) {
    console.error("delete_business_and_all_data failed:", rpcError.message);

    if (rpcError.message?.includes("USER_NOT_FOUND")) {
      return json({ error: "Account not found" }, 404);
    }
    if (rpcError.message?.includes("UNAUTHORIZED")) {
      return json({ error: "Only the business owner can delete this account" }, 403);
    }

    return json({ error: "Failed to delete account data" }, 500);
  }

  // 2. Delete the auth user — must be done after DB cleanup
  const { error: authDeleteError } = await supabaseAdmin.auth.admin.deleteUser(
    user.id
  );

  if (authDeleteError) {
    console.error("Auth user deletion failed:", authDeleteError.message);
    // DB data is already gone — log this for manual cleanup
    return json({
      error: "Account data deleted but auth cleanup failed. Contact support.",
      code:  "AUTH_CLEANUP_FAILED",
    }, 500);
  }

  console.log(`✅ Account fully deleted: ${user.id} business: ${data.businessId}`);

  return json({ success: true, message: "Account deleted successfully" }, 200);
});

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}