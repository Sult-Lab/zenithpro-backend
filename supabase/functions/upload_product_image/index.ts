import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return response({ error: "Unauthorized" }, 401);
    }

    // Single admin client — verify the user token manually
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // getUser() with the user's JWT validates it against Supabase Auth
    const { data: { user }, error: authError } = await admin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );

    if (authError || !user) {
      console.error("Auth failed:", authError?.message);
      return response({ error: "Unauthorized" }, 401);
    }

    console.log("Authenticated user:", user.id);

    const body = await req.json();
    const { imageBase64, businessId } = body;

    if (!imageBase64 || !businessId) {
      return response({ error: "Missing imageBase64 or businessId" }, 400);
    }

    let binaryStr: string;
    try {
      binaryStr = atob(imageBase64);
    } catch {
      return response({ error: "Invalid base64" }, 400);
    }

    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }

    const fileName = `${crypto.randomUUID()}.jpg`;
    const filePath = `products/${businessId}/${fileName}`;

    console.log("Uploading:", filePath, "size:", buffer.length);

    const { error: uploadError } = await admin.storage
      .from("product_images")
      .upload(filePath, buffer, { contentType: "image/jpeg" });

    if (uploadError) {
      console.error("Upload error:", uploadError.message);
      return response({ error: uploadError.message }, 500);
    }

    console.log("Upload success:", filePath);
    return response({ imagePath: filePath });

  } catch (e) {
    console.error("Unexpected error:", e.message);
    return response({ error: e.message }, 500);
  }
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}