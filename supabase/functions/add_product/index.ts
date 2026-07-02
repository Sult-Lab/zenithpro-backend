import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return json({ error: "Invalid JWT" }, 401);
    }

    const body = await req.json();
    const {
      clientId,     
      name,
      description,
      category,
      baseSalesPrice,
      baseCostPrice,
      isActive,
      businessId,
      imageUrls,
      variants,
      expiryWarningDays
    } = body;

    if (!clientId || !name || !businessId) {
      return json({ error: "Missing required fields: clientId, name, businessId" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabaseAdmin.rpc("create_product_with_variants", {
      p_client_id:          clientId,           // ← new
      p_name:               name,
      p_description:        description ?? null,
      p_category:           category ?? null,
      p_base_sales_price:   baseSalesPrice,
      p_base_cost_price:    baseCostPrice,
      p_is_active:          isActive ?? true,
      p_business_id:        businessId,
      p_image_urls:         imageUrls ?? [],
      p_variants:           variants ?? [],
      p_expiry_warning_days: expiryWarningDays ?? null
    });

    if (error) {
      console.error("RPC error:", error);
      return json({ error: error.message }, 500);
    }

    // Return both productId and updatedAt so Room can mark the record SYNCED
    // with the exact server timestamp
    return json({
      success:   true,
      productId: data.productId,
      updatedAt: data.updatedAt   // ← new: used by SyncResponse in the Android client
    }, 200);

  } catch (e) {
    console.error("Unexpected error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}