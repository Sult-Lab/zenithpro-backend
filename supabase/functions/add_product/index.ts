import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mapError, getStatus } from "../_shared/errors.ts";

serve(async (req) => {
  try {
    // ============================================================
    // 1. Validate Authorization header
    // ============================================================
    const authHeader = req.headers.get("Authorization");

    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ============================================================
    // 2. Create user-scoped Supabase client
    //    This client uses the JWT from the request.
    // ============================================================
    const supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      }
    );

    // ============================================================
    // 3. Verify JWT and get authenticated user
    // ============================================================
    const {
      data: { user },
      error: userError,
    } = await supabaseUser.auth.getUser();

    if (userError || !user) {
      return json({ error: "Invalid JWT" }, 401);
    }

    // ============================================================
    // 4. Create service-role client
    //
    // IMPORTANT:
    // This client bypasses RLS, so all authorization checks MUST
    // happen explicitly below before using it.
    // ============================================================
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ============================================================
    // 5. Get user's profile
    // ============================================================
    const {
      data: profile,
      error: profileError,
    } = await supabaseAdmin
      .from("user_profiles")
      .select("role, first_name, last_name, business_id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Profile lookup error:", profileError);

      return json(
        {
          error: "Unable to verify user profile",
          code: "PROFILE_LOOKUP_FAILED",
        },
        500
      );
    }

    if (!profile) {
      return json(
        {
          error: "User profile not found",
          code: "PROFILE_NOT_FOUND",
        },
        404
      );
    }

    // ============================================================
    // 6. Check role permissions
    //
    // Only ADMIN and MANAGER can create/edit products.
    // ============================================================
    if (!["ADMIN", "MANAGER"].includes(profile.role)) {
      return json(
        {
          error: "You do not have permission to add or edit products",
          code: "INSUFFICIENT_PERMISSIONS",
        },
        403
      );
    }

    // ============================================================
    // 7. Parse request body
    // ============================================================
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
      branchId,
      imageUrls,
      variants,
      expiryWarningDays,
      unitType,
      updatedBy,
    } = body;

    // ============================================================
    // 8. Validate required fields
    // ============================================================
    if (!clientId || !name || !businessId) {
      return json(
        {
          error:
            "Missing required fields: clientId, name, businessId",
        },
        400
      );
    }

    // ============================================================
    // 9. Verify user belongs to the business
    //
    // Since the RPC client uses SERVICE_ROLE_KEY, this check is
    // critical. Without it, an ADMIN/MANAGER could potentially
    // submit another businessId.
    // ============================================================
    if (profile.business_id !== businessId) {
      return json(
        {
          error: "Unauthorized",
          code: "BUSINESS_ACCESS_DENIED",
        },
        403
      );
    }

    // ============================================================
    // 10. Build audit information
    // ============================================================
    const updatedByName =
      `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim();

    // Optional fallback in case the profile has no name.
    const auditName = updatedByName || "Unknown User";

    // ============================================================
    // 11. Call RPC
    // ============================================================
    const {
      data,
      error,
    } = await supabaseAdmin.rpc("create_product_with_variants", {
      p_client_id: clientId,
      p_name: name,
      p_description: description ?? null,
      p_category: category ?? null,
      p_base_sales_price: baseSalesPrice,
      p_base_cost_price: baseCostPrice,
      p_is_active: isActive ?? true,
      p_business_id: businessId,
      p_image_urls: imageUrls ?? [],
      p_variants: variants ?? [],
      p_expiry_warning_days: expiryWarningDays ?? null,
      p_branch_id: branchId,
      p_unit_type: unitType ?? "UNIT",

      // Audit fields
      p_updated_by: user.id,
      p_updated_by_name: auditName,
    });

    // ============================================================
    // 12. Handle RPC errors
    // ============================================================
    if (error) {
      console.error("RPC error:", error);

      // Duplicate product name
      if (
        error.message?.includes("products_business_id_name_key") ||
        error.message?.includes("duplicate key value")
      ) {
        return json(
          {
            error:
              "A product with this name already exists in your business. Please use a different name.",
            code: "PRODUCT_ALREADY_EXISTS",
          },
          409
        );
      }

      return json(
        {
          error: mapError(error.message),
          code: "RPC_ERROR",
        },
        getStatus(error.message)
      );
    }

    // ============================================================
    // 13. Return successful response
    //
    // updatedAt is returned so the Android/Room sync layer can
    // mark the local record as SYNCED using the exact server time.
    // ============================================================
    return json(
      {
        success: true,
        productId: data.productId,
        updatedAt: data.updatedAt,
      },
      200
    );
  } catch (e) {
    // ============================================================
    // 14. Unexpected error
    // ============================================================
    console.error("Unexpected error:", e);

    const message = e instanceof Error ? e.message : String(e);
    return json({ error: mapError(message) }, getStatus(message));
  }
});

// ================================================================
// JSON Response Helper
// ================================================================
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}