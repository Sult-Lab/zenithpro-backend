// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { items, payments, businessId } = await req.json();

    const total = items.reduce(
      (sum, i) => sum + i.price * i.quantity, 0
    );

    const { data: sale } = await supabase
      .from("sales")
      .insert({ business_id: businessId, total_amount: total })
      .select()
      .single();

    for (const item of items) {
      await supabase.from("sale_items").insert({
        sale_id: sale.id,
        variant_id: item.variantId,
        quantity: item.quantity,
        price: item.price
      });

      // FIFO deduction
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/process_sale`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            variantId: item.variantId,
            quantity: item.quantity
          })
        }
      );
    }

    for (const payment of payments) {
      await supabase.from("payments").insert({
        sale_id: sale.id,
        method: payment.method,
        amount: payment.amount
      });
    }

    return new Response(JSON.stringify({ saleId: sale.id }));

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 400 });
  }
});
