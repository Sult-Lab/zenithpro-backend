import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.57.0'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const SEND_WELCOME_SECRET = Deno.env.get('SEND_WELCOME_SECRET')
const SENDBYTE_API_KEY = Deno.env.get('SENDBYTE_API_KEY')

if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required')
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
if (!SEND_WELCOME_SECRET) throw new Error('SEND_WELCOME_SECRET is required')
if (!SENDBYTE_API_KEY) throw new Error('SENDBYTE_API_KEY is required')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const EMAIL_TEMPLATE = String.raw`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F7F5EF; padding:32px 0; font-family:'Segoe UI', Helvetica, Arial, sans-serif;">
  <tr>
    <td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #DEDACE;">
        <tr>
          <td style="background-color:#0B4F4A; padding:32px 40px; text-align:center;">
            <span style="font-family:'Segoe UI', Helvetica, Arial, sans-serif; font-size:22px; font-weight:700; color:#F7F5EF; letter-spacing:0.01em;">Zenith<span style="color:#E8A94C;">Pro</span></span>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 40px 8px;">
            <h1 style="margin:0 0 16px; font-size:21px; color:#0D1614; font-weight:600;">Welcome, {{firstName}} 👋</h1>
            <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#4a463c;">{{businessName}} is set up and ready to go. Here's how to get the most out of ZenithPro from day one.</p>
          </td>
        </tr>
        <tr><td style="padding:0 40px 8px;"><p style="margin:0 0 14px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#C9821F;">Start here</p></td></tr>
        <tr>
          <td style="padding:0 40px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:0 0 16px; vertical-align:top; width:32px;"><span style="display:inline-block; width:24px; height:24px; border-radius:50%; background-color:#0B4F4A; color:#fff; font-size:13px; font-weight:600; text-align:center; line-height:24px;">1</span></td><td style="padding:0 0 16px; vertical-align:top;"><p style="margin:0; font-size:14px; font-weight:600; color:#0D1614;">Add your first product</p><p style="margin:2px 0 0; font-size:13px; line-height:1.5; color:#6b6558;">Head to Inventory → Add Product. You can add variants (size, color, etc.) and stock levels right away, even offline.</p></td></tr>
              <tr><td style="padding:0 0 16px; vertical-align:top;"><span style="display:inline-block; width:24px; height:24px; border-radius:50%; background-color:#0B4F4A; color:#fff; font-size:13px; font-weight:600; text-align:center; line-height:24px;">2</span></td><td style="padding:0 0 16px; vertical-align:top;"><p style="margin:0; font-size:14px; font-weight:600; color:#0D1614;">Check your business settings</p><p style="margin:2px 0 0; font-size:13px; line-height:1.5; color:#6b6558;">In Settings, confirm your currency symbol and business details are correct before your first sale.</p></td></tr>
              <tr><td style="padding:0 0 16px; vertical-align:top;"><span style="display:inline-block; width:24px; height:24px; border-radius:50%; background-color:#0B4F4A; color:#fff; font-size:13px; font-weight:600; text-align:center; line-height:24px;">3</span></td><td style="padding:0 0 16px; vertical-align:top;"><p style="margin:0; font-size:14px; font-weight:600; color:#0D1614;">Invite your team (optional)</p><p style="margin:2px 0 0; font-size:13px; line-height:1.5; color:#6b6558;">Settings → Staff lets you add managers or staff with the right access level for each person.</p></td></tr>
              <tr><td style="padding:0; vertical-align:top;"><span style="display:inline-block; width:24px; height:24px; border-radius:50%; background-color:#0B4F4A; color:#fff; font-size:13px; font-weight:600; text-align:center; line-height:24px;">4</span></td><td style="padding:0; vertical-align:top;"><p style="margin:0; font-size:14px; font-weight:600; color:#0D1614;">Make your first sale</p><p style="margin:2px 0 0; font-size:13px; line-height:1.5; color:#6b6558;">Tap Sales → New Sale. Cash, card, transfer, split, or debt — checkout adapts to how your customer pays.</p></td></tr>
            </table>
          </td>
        </tr>
        <tr><td style="padding:0 40px 8px; border-top:1px solid #DEDACE;"><p style="margin:24px 0 14px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:#C9821F;">What you can do with ZenithPro</p></td></tr>
        <tr><td style="padding:0 40px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F7F5EF; border-radius:10px;"><tr><td style="padding:20px 22px;"><p style="margin:0 0 10px; font-size:13px; line-height:1.6; color:#4a463c;"><strong style="color:#0D1614;">Inventory</strong> — products, variants, and stock, with low-stock alerts</p><p style="margin:0 0 10px; font-size:13px; line-height:1.6; color:#4a463c;"><strong style="color:#0D1614;">Sales</strong> — fast checkout, sales history, filter by date/staff/method</p><p style="margin:0 0 10px; font-size:13px; line-height:1.6; color:#4a463c;"><strong style="color:#0D1614;">Customers</strong> — purchase history and debt tracking in one place</p><p style="margin:0 0 10px; font-size:13px; line-height:1.6; color:#4a463c;"><strong style="color:#0D1614;">Expenses</strong> — log spending, see it against your sales</p><p style="margin:0 0 10px; font-size:13px; line-height:1.6; color:#4a463c;"><strong style="color:#0D1614;">Materials & Production</strong> — for businesses that make what they sell</p><p style="margin:0; font-size:13px; line-height:1.6; color:#4a463c;"><strong style="color:#0D1614;">Reports</strong> — sales, profit, and customer trends at a glance</p></td></tr></table></td></tr>
        <tr><td style="padding:0 40px 32px;"><p style="margin:0; font-size:13px; line-height:1.6; color:#6b6558;">Everything works offline — sales, stock updates, and customer records save instantly on your device and sync automatically once you're back online. No lost data, no waiting on a signal.</p></td></tr>
        <tr><td style="padding:20px 40px 32px; border-top:1px solid #DEDACE;"><p style="margin:0; font-size:12px; color:#8a8474;">Sent to {{email}} because you just confirmed your ZenithPro account. Questions? Just reply to this email.</p></td></tr>
      </table>
    </td>
  </tr>
</table>`

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const a = new Uint8Array(providedHash)
  const b = new Uint8Array(expectedHash)
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonError('Method not allowed', 405)

  const providedSecret = req.headers.get('x-webhook-secret')
  if (!providedSecret || !(await secretsMatch(providedSecret, SEND_WELCOME_SECRET))) {
    console.warn('Welcome email rejected: invalid webhook secret')
    return jsonError('Unauthorized', 401)
  }

  let payload: { user_id?: unknown; email?: unknown }
  try {
    payload = await req.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  const userId = typeof payload.user_id === 'string' ? payload.user_id : ''
  const email = typeof payload.email === 'string' ? payload.email.trim() : ''
  if (!userId || !email) return jsonError('user_id and email are required', 400)

  try {
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('first_name, business_id, role')
      .eq('id', userId)
      .maybeSingle()

    if (profileError) throw profileError
    if (!profile || profile.role !== 'ADMIN' || !profile.business_id) {
      console.error('Welcome email lookup failed: eligible owner profile not found', { userId })
      return jsonError('Eligible owner profile not found', 404)
    }

    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', profile.business_id)
      .maybeSingle()

    if (businessError) throw businessError
    if (!business?.name) {
      console.error('Welcome email lookup failed: business not found', { userId, businessId: profile.business_id })
      return jsonError('Business not found', 404)
    }

    const firstName = escapeHtml(profile.first_name || 'there')
    const businessName = escapeHtml(business.name)
    const recipientEmail = escapeHtml(email)
    const emailHtml = EMAIL_TEMPLATE
      .replaceAll('{{firstName}}', firstName)
      .replaceAll('{{businessName}}', businessName)
      .replaceAll('{{email}}', recipientEmail)

    const sendByteResponse = await fetch('https://api.sendbyte.africa/v1/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SENDBYTE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ZenithPro <accounts@zenithpro.name.ng>',
        to: email,
        subject: `Welcome to ZenithPro — let's get ${business.name} set up`,
        html: emailHtml,
      }),
    })

    if (!sendByteResponse.ok) {
      const sendByteError = await sendByteResponse.text()
      console.error('SendByte welcome email failed', {
        userId,
        status: sendByteResponse.status,
        response: sendByteError,
      })
      return jsonError('Email delivery failed', 502)
    }

    console.info('SendByte welcome email sent successfully', {
      userId,
      email,
      businessId: profile.business_id,
    })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Welcome email function failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return jsonError('Internal server error', 500)
  }
})