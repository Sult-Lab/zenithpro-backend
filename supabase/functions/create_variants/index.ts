// Setup type definitions for built-in Supabase Runtime APIs
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { productId, variants } = await req.json();

    if (!productId || !variants?.length) {
      return new Response("Invalid payload", { status: 400 });
    }

    for (const variant of variants) {

      // 1️⃣ Create variant
      const { data: createdVariant, error: variantError } =
        await supabase.from("product_variants")
          .insert({
            product_id: productId,
            sku: variant.sku,
            sales_price: variant.salesPrice,
            cost_price: variant.costPrice,
            barcode: variant.barcode
          })
          .select()
          .single();

      if (variantError) throw variantError;

      // 2️⃣ Attributes
      for (const attr of variant.attributes) {

        // option
        const { data: option } = await supabase
          .from("product_options")
          .select()
          .eq("product_id", productId)
          .eq("name", attr.optionName)
          .single();

        const optionId = option
          ? option.id
          : (await supabase.from("product_options")
              .insert({ product_id: productId, name: attr.optionName })
              .select()
              .single()).data.id;

        // option value
        const { data: optionValue } = await supabase
          .from("product_option_values")
          .select()
          .eq("option_id", optionId)
          .eq("value", attr.optionValue)
          .single();

        const valueId = optionValue
          ? optionValue.id
          : (await supabase.from("product_option_values")
              .insert({ option_id: optionId, value: attr.optionValue })
              .select()
              .single()).data.id;

        await supabase.from("product_variant_attributes").insert({
          variant_id: createdVariant.id,
          option_value_id: valueId
        });
      }

      // 3️⃣ Stock batches
      for (const batch of variant.stock) {
        await supabase.from("product_stock").insert({
          variant_id: createdVariant.id,
          quantity: batch.quantity,
          expiry_date: batch.expiryDate
        });
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500 }
    );
  }
});
