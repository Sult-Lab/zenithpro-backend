// supabase/functions/delete_product_image/index.ts

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mapError, getStatus } from "../_shared/errors.ts";

serve(async (req) => {
  try {
    const payload = await req.json();

    const imagePath = payload.record?.image_url;

    if (!imagePath) {
      return new Response("No image to delete", { status: 200 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error } = await supabase.storage
      .from("product_images")
      .remove([imagePath]);

    if (error) {
      console.error("delete_product_image error:", error.message);
      return new Response(JSON.stringify({ error: mapError(error.message) }), {
        status: getStatus(error.message),
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Deleted", { status: 200 });

  } catch (e) {
    return new Response("Error", { status: 500 });
  }
});
