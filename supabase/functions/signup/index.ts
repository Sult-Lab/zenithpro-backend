import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mapError } from "../_shared/errors.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });

const error = (
  message: string,
  status = 400,
  code = "VALIDATION_ERROR"
) => json({ error: message, code }, status);

const requiredEnv = (name: string): string => {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return error(
      "Method not allowed",
      405,
      "METHOD_NOT_ALLOWED"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Environment
  // ─────────────────────────────────────────────────────────────

  let SUPABASE_URL: string;
  let SUPABASE_SERVICE_ROLE_KEY: string;
  let SENDBYTE_API_KEY: string;

  try {
    SUPABASE_URL = requiredEnv("SUPABASE_URL");
    SUPABASE_SERVICE_ROLE_KEY =
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    SENDBYTE_API_KEY = requiredEnv("SENDBYTE_API_KEY");
  } catch (err) {
    console.error("Environment configuration error:", err);

    return error(
      "Server configuration error",
      500,
      "SERVER_CONFIGURATION_ERROR"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Parse request
  // ─────────────────────────────────────────────────────────────

  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return error(
      "Invalid JSON body",
      400,
      "INVALID_JSON"
    );
  }

  const {
    email,
    password,
    confirmPassword,
    adminFirstName,
    adminLastName,
    businessName,
    businessPhone,
    businessAddress,
    businessLogoUrl,
    acceptTerms,
  } = body;

  // ─────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────

  const missing = (
    [
      ["email", email],
      ["password", password],
      ["confirmPassword", confirmPassword],
      ["adminFirstName", adminFirstName],
      ["adminLastName", adminLastName],
      ["businessName", businessName],
    ] as [string, unknown][]
  )
    .filter(
      ([, value]) =>
        value === undefined ||
        value === null ||
        String(value).trim() === ""
    )
    .map(([key]) => key);

  if (missing.length > 0) {
    return error(
      `Missing required fields: ${missing.join(", ")}`,
      400,
      "MISSING_FIELDS"
    );
  }

  const normalizedEmail = String(email)
    .toLowerCase()
    .trim();

  const emailRegex =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(normalizedEmail)) {
    return error(
      "Invalid email address",
      400,
      "INVALID_EMAIL"
    );
  }

  const pwd = String(password);

  if (pwd.length < 8) {
    return error(
      "Password must be at least 8 characters",
      400,
      "WEAK_PASSWORD"
    );
  }

  if (pwd !== String(confirmPassword)) {
    return error(
      "Passwords do not match",
      400,
      "PASSWORD_MISMATCH"
    );
  }

  if (acceptTerms !== true) {
    return error(
      "You must accept the terms and conditions",
      400,
      "TERMS_NOT_ACCEPTED"
    );
  }

  const firstName = String(adminFirstName).trim();
  const lastName = String(adminLastName).trim();
  const bName = String(businessName).trim();

  if (firstName.length < 2) {
    return error(
      "First name must be at least 2 characters",
      400,
      "INVALID_FIRST_NAME"
    );
  }

  if (lastName.length < 2) {
    return error(
      "Last name must be at least 2 characters",
      400,
      "INVALID_LAST_NAME"
    );
  }

  if (bName.length < 2) {
    return error(
      "Business name must be at least 2 characters",
      400,
      "INVALID_BUSINESS_NAME"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Supabase admin client
  // ─────────────────────────────────────────────────────────────

  const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );

  // ─────────────────────────────────────────────────────────────
  // Duplicate business/profile check
  // ─────────────────────────────────────────────────────────────

  const { data: existingProfile, error: profileCheckError } =
    await supabase
      .from("user_profiles")
      .select("id")
      .eq("email", normalizedEmail)
      .maybeSingle();

  if (profileCheckError) {
    console.error(
      "Profile duplicate check failed:",
      profileCheckError.message
    );

    return error(
      "Unable to verify account availability",
      500,
      "DATABASE_ERROR"
    );
  }

  if (existingProfile) {
    return error(
      "An account with this email already exists",
      409,
      "DUPLICATE_EMAIL"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Create Auth user + generate confirmation link
  //
  // IMPORTANT:
  // generateLink(type: "signup") creates the user and returns
  // the action_link. We do NOT call admin.createUser() separately.
  // ─────────────────────────────────────────────────────────────

  const { data: linkData, error: linkError } =
    await supabase.auth.admin.generateLink({
      type: "signup",
      email: normalizedEmail,
      password: pwd,
      options: {
        redirectTo:
          "https://zenithpro.name.ng/auth/confirm",
        data: {
          first_name: firstName,
          last_name: lastName,
        },
      },
    });

  if (linkError || !linkData?.user) {
    console.error(
      "Failed to create auth user:",
      linkError?.message
    );

    if (
      linkError?.message
        ?.toLowerCase()
        .includes("already")
    ) {
      return error(
        "An account with this email already exists",
        409,
        "DUPLICATE_EMAIL"
      );
    }

    const message = linkError?.message ?? "Failed to create account";
    return error(
      mapError(message),
      400,
      "AUTH_ERROR"
    );
  }

  const userId = linkData.user.id;
  const confirmationUrl =
    linkData.properties.action_link;

  console.log(
    `Auth user created: ${userId}`
  );

  // ─────────────────────────────────────────────────────────────
  // Register business/profile
  // ─────────────────────────────────────────────────────────────

  const { data: result, error: rpcError } =
    await supabase.rpc(
      "register_business",
      {
        p_auth_user_id: userId,
        p_email: normalizedEmail,
        p_first_name: firstName,
        p_last_name: lastName,
        p_business_name: bName,
        p_business_phone:
          businessPhone
            ? String(businessPhone).trim()
            : null,
        p_business_address:
          businessAddress
            ? String(businessAddress).trim()
            : null,
        p_business_logo_url:
          businessLogoUrl
            ? String(businessLogoUrl).trim()
            : null,
      }
    );

  if (rpcError) {
    console.error(
      "register_business RPC failed:",
      rpcError.message
    );

    // Auth user should not remain if business registration failed.
    const { error: deleteError } =
      await supabase.auth.admin.deleteUser(
        userId
      );

    if (deleteError) {
      console.error(
        "Failed to cleanup auth user:",
        deleteError.message
      );
    }

    if (
      rpcError.message?.includes(
        "DUPLICATE_EMAIL"
      )
    ) {
      return error(
        "An account with this email already exists",
        409,
        "DUPLICATE_EMAIL"
      );
    }

    if (
      rpcError.message?.includes(
        "DUPLICATE_BUSINESS"
      )
    ) {
      return error(
        "A business with this name already exists",
        409,
        "DUPLICATE_BUSINESS"
      );
    }

    return error(
      "Registration failed. Please try again.",
      500,
      "REGISTRATION_FAILED"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Send confirmation email using SendByte
  // ─────────────────────────────────────────────────────────────

  const safeFirstName =
    escapeHtml(firstName);

 const emailHtml = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="background-color:#F7F5EF; padding:32px 0; font-family:'Segoe UI', Helvetica, Arial, sans-serif;">

  <tr>
    <td align="center">

      <table role="presentation" width="480" cellpadding="0" cellspacing="0"
        style="background-color:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #DEDACE;">

        <!-- Header -->
        <tr>
          <td style="background-color:#0B4F4A; padding:32px 40px; text-align:center;">
            <span style="font-size:22px; font-weight:700; color:#F7F5EF;">
              Zenith<span style="color:#E8A94C;">Pro</span>
            </span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px 40px 24px;">

            <h1 style="margin:0 0 16px; font-size:20px; color:#0D1614; font-weight:600;">
              Confirm your account
            </h1>

            <p style="color:#475569;">
              Hi ${firstName},
            </p>

            <p style="margin:0 0 24px; font-size:15px; line-height:1.6; color:#4a463c;">
              Thanks for setting up ZenithPro. Confirm your email address
              to activate your account and start managing your business.
            </p>

            <!-- Button -->
            <table role="presentation" cellpadding="0" cellspacing="0"
              style="margin:0 0 28px;">

              <tr>
                <td style="border-radius:10px; background-color:#E8A94C;">

                  <a href="${confirmationUrl}"
                    style="display:inline-block; padding:13px 32px;
                    font-size:15px; font-weight:600; color:#0D1614;
                    text-decoration:none; border-radius:10px;">

                    Confirm your email

                  </a>

                </td>
              </tr>
            </table>

            <p style="margin:0 0 8px; font-size:13px; line-height:1.6; color:#8a8474;">
              Or paste this link into your browser:
            </p>

            <p style="margin:0 0 24px; font-size:13px; line-height:1.6; word-break:break-all;">

              <a href="${confirmationUrl}" style="color:#0B4F4A;">
                ${confirmationUrl}
              </a>

            </p>

            <p style="margin:0; font-size:13px; line-height:1.6; color:#8a8474;">
              If you didn't create a ZenithPro account,
              you can safely ignore this email.
            </p>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px 32px; border-top:1px solid #DEDACE;">

            <p style="margin:0; font-size:12px; color:#8a8474;">
              This link was sent to ${normalizedEmail}.
              Sent by ZenithPro.
            </p>

          </td>
        </tr>

      </table>

    </td>
  </tr>

</table>
`;

  const sendByteResponse =
    await fetch(
      "https://api.sendbyte.africa/v1/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDBYTE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "ZenithPro <hello@zenithpro.name.ng>",
          to: normalizedEmail,
          subject:
            "Confirm your ZenithPro email address",
          html: emailHtml,
        }),
      }
    );

  if (!sendByteResponse.ok) {
    const sendByteError =
      await sendByteResponse.text();

    console.error(
      "SendByte email failed:",
      sendByteResponse.status,
      sendByteError
    );

    // IMPORTANT:
    // Do not delete the account here.
    //
    // The DB registration succeeded. A temporary
    // email-provider failure should not destroy the
    // user's account.
    //
    // You should provide a resend-confirmation endpoint
    // separately.

    return json(
      {
        error:
          "Account created, but we could not send the confirmation email. Please request another confirmation email.",
        code: "CONFIRMATION_EMAIL_FAILED",
        userId,
      },
      502
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Success
  // ─────────────────────────────────────────────────────────────

  console.log(
    `Registration complete — business: ${result.businessId} ` +
      `branch: ${result.branchId} ` +
      `user: ${result.userId}`
  );

  return json(
    {
      userId: result.userId,
      businessId: result.businessId,
      defaultBranchId: result.branchId,
      emailConfirmationRequired: true,
    },
    201
  );
});