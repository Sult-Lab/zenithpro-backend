/**
 * _shared/nomba-auth.ts
 *
 * Handles Nomba OAuth2 token lifecycle for all edge functions.
 * Tokens expire after 30 minutes — we cache and refresh proactively.
 *
 * Usage:
 *   import { getNombaToken } from "../_shared/nomba-auth.ts";
 *   const { accessToken, accountId } = await getNombaToken();
 */

interface TokenCache {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

// Module-level cache — survives across requests within the same isolate lifetime
let tokenCache: TokenCache | null = null;

function getBaseUrl(): string {
  return Deno.env.get("NOMBA_BASE_URL") ?? "https://sandbox.nomba.com";
}

export function getNombaAccountId(): string {
  const id = Deno.env.get("NOMBA_ACCOUNT_ID");
  if (!id) throw new Error("NOMBA_ACCOUNT_ID env var is not set");
  return id;
}

async function issueToken(): Promise<TokenCache> {
  const clientId = Deno.env.get("NOMBA_CLIENT_ID");
  const clientSecret = Deno.env.get("NOMBA_CLIENT_SECRET");
  const accountId = getNombaAccountId();

  if (!clientId || !clientSecret) {
    throw new Error("NOMBA_CLIENT_ID or NOMBA_CLIENT_SECRET env var is not set");
  }

  const res = await fetch(`${getBaseUrl()}/v1/auth/token/issue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "accountId": accountId,
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const json = await res.json();
  if (json.code !== "00") {
    throw new Error(`Nomba auth failed: ${json.description}`);
  }

  const { access_token, refresh_token, expiresAt } = json.data;
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    // expiresAt from Nomba is ISO string — convert to unix ms
    expiresAt: new Date(expiresAt).getTime(),
  };
}

async function refreshToken(cache: TokenCache): Promise<TokenCache> {
  const accountId = getNombaAccountId();

  const res = await fetch(`${getBaseUrl()}/v1/auth/token/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cache.accessToken}`,
      "accountId": accountId,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: cache.refreshToken,
    }),
  });

  const json = await res.json();
  if (json.code !== "00") {
    // Refresh failed — fall back to full re-issue
    console.warn("Token refresh failed, re-issuing:", json.description);
    return await issueToken();
  }

  const { access_token, refresh_token, expiresAt } = json.data;
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: new Date(expiresAt).getTime(),
  };
}

/**
 * Returns a valid Nomba access token.
 * Handles issuing, caching, and proactive refresh (5 min before expiry).
 */
export async function getNombaToken(): Promise<{
  accessToken: string;
  accountId: string;
  baseUrl: string;
}> {
  const now = Date.now();
  const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

  if (!tokenCache) {
    tokenCache = await issueToken();
  } else if (now >= tokenCache.expiresAt - REFRESH_BUFFER_MS) {
    tokenCache = await refreshToken(tokenCache);
  }

  return {
    accessToken: tokenCache.accessToken,
    accountId: getNombaAccountId(),
    baseUrl: getBaseUrl(),
  };
}