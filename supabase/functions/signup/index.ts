import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const {
    email,
    password,
    confirmPassword,
    adminFirstName,
    adminLastName,
    businessName,
    businessPhone,
    businessAddress,
    acceptTerms
  } = await req.json();

  // ---- VALIDATION ----
  if (!email || !password || !confirmPassword) {
    return new Response("Missing credentials", { status: 400 });
  }

  if (password !== confirmPassword) {
    return new Response("Passwords do not match", { status: 400 });
  }

  if (!acceptTerms) {
    return new Response("Terms must be accepted", { status: 400 });
  }

  if (!businessName || !adminFirstName || !adminLastName) {
    return new Response("Missing required fields", { status: 400 });
  }

  // ---- CREATE AUTH USER ----
  const { data: authData, error: authError } =
  await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      first_name: adminFirstName,
      last_name: adminLastName
    }
  });

  if (authError || !authData.user) {
    return new Response(authError?.message ?? "Auth failed", { status: 400 });
  }

  // Explicitly confirm the email
const { error: confirmError } = await supabase.auth.admin.updateUserById(
  authData.user.id,
  { email_confirm: true }
);

if (confirmError) {
  return new Response(confirmError.message, { status: 400 });
}

  // ---- CREATE BUSINESS ----
  const { data: business, error: businessError } =
    await supabase
      .from("businesses")
      .insert({
        name: businessName,
        phone: businessPhone,
        address: businessAddress
      })
      .select()
      .single();

  if (businessError) {
    return new Response(businessError.message, { status: 400 });
  }

  // ---- CREATE ADMIN PROFILE ----
  const { error: profileError } =
    await supabase.from("user_profiles").insert({
      id: authData.user.id,
      business_id: business.id,
      first_name: adminFirstName,
      last_name: adminLastName,
      email: email,
      role: "ADMIN",
      status: "ACTIVE"
    });

  if (profileError) {
    return new Response(profileError.message, { status: 400 });
  }

  return new Response(
    JSON.stringify({
      userId: authData.user.id,
      businessId: business.id
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
