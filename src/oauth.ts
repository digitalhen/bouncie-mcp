// ---------------------------------------------------------------------------
// OAuth 2.0 — Bouncie OAuth proxy for Claude.ai hosted MCP
//
// Instead of a password gate, users authorize with their own Bouncie account.
// The MCP server acts as an OAuth provider to Claude.ai while proxying
// authorization to Bouncie's OAuth under the hood.
//
// Everything this server needs to remember is carried *inside* the values it
// hands out, sealed with a key both instances derive identically. Nothing is
// kept in memory or on disk, so the service runs correctly behind a load
// balancer that fans requests across hosts: any instance can complete a flow
// another instance began.
// ---------------------------------------------------------------------------

import { Router } from "express";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Sealed values — AES-256-GCM, authenticated, with a purpose label and expiry
// ---------------------------------------------------------------------------

/** The pending Bouncie flow, carried as the `state` we hand to Bouncie. */
interface PendingAuth {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri: string;
  mcpState?: string;
  scope?: string;
}

/** The issued MCP authorization code. */
interface AuthCode {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri: string;
  bouncieAccessToken: string;
  scope?: string;
}

/** An access or refresh token. */
interface TokenPayload {
  clientId: string;
  bouncieAccessToken: string;
  scope?: string;
}

interface Sealed<T> {
  p: string; // purpose
  e: number; // expiry, epoch ms
  d: T; // payload
}

let sealingKey: Buffer;

/**
 * Both instances must derive the same key without shared storage. TOKEN_SECRET
 * is preferred; otherwise derive from the Bouncie client secret, which is by
 * definition identical everywhere this app runs. Rotating that secret
 * invalidates outstanding tokens, which is the correct behaviour anyway.
 */
function initSealingKey(explicitSecret: string | undefined, clientSecret: string) {
  sealingKey = crypto.hkdfSync(
    "sha256",
    Buffer.from(explicitSecret || clientSecret, "utf8"),
    Buffer.from("bouncie-mcp-oauth", "utf8"),
    Buffer.from("sealing-key-v1", "utf8"),
    32,
  ) as unknown as Buffer;
  sealingKey = Buffer.from(sealingKey);
}

function seal<T>(purpose: string, data: T, ttlMs: number): string {
  const payload: Sealed<T> = { p: purpose, e: Date.now() + ttlMs, d: data };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealingKey, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal<T>(purpose: string, value: string | undefined): T | null {
  if (!value) return null;
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealingKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    const payload: Sealed<T> = JSON.parse(json);
    if (payload.p !== purpose) return null;
    if (payload.e < Date.now()) return null;
    return payload.d;
  } catch {
    // Any tampering, a wrong key, or malformed input lands here.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token validation & Bouncie token lookup — used by MCP auth middleware
// ---------------------------------------------------------------------------

export function isValidToken(token: string): boolean {
  return unseal<TokenPayload>("access", token) !== null;
}

/** Look up the Bouncie access token associated with an MCP bearer token */
export function getBouncieToken(mcpToken: string): string | null {
  return unseal<TokenPayload>("access", mcpToken)?.bouncieAccessToken ?? null;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  publicUrl: string;
  tokenTtlMs: number;
  bouncieClientId: string;
  bouncieClientSecret: string;
  /** Optional explicit key material; defaults to deriving from the client secret. */
  tokenSecret?: string;
}

// ---------------------------------------------------------------------------
// Bouncie OAuth helpers
// ---------------------------------------------------------------------------

const BOUNCIE_AUTH_DIALOG = "https://auth.bouncie.com/dialog/authorize";
const BOUNCIE_TOKEN_URL = "https://auth.bouncie.com/oauth/token";

const AUTH_FLOW_TTL_MS = 10 * 60 * 1000;

async function exchangeBouncieCode(
  code: string,
  config: OAuthConfig,
): Promise<string> {
  const callbackUrl = `${config.publicUrl}/callback`;
  const body = new URLSearchParams({
    client_id: config.bouncieClientId,
    client_secret: config.bouncieClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl,
  });

  const res = await fetch(BOUNCIE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bouncie token exchange failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createOAuthRouter(config: OAuthConfig): Router {
  initSealingKey(config.tokenSecret, config.bouncieClientSecret);
  const router = Router();

  // CORS — Claude.ai fetches discovery/registration/token endpoints from the browser
  router.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // RFC 9728 protected-resource metadata — required by the MCP auth spec so the
  // client can discover which authorization server guards /mcp.
  const protectedResourceMetadata = (_req: any, res: any) => {
    res.json({
      resource: `${config.publicUrl}/mcp`,
      authorization_servers: [config.publicUrl],
      bearer_methods_supported: ["header"],
    });
  };
  router.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  router.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  // RFC 8414 metadata — served at the root and at the path-suffixed variant that
  // clients probe for an issuer with a path component.
  const authServerMetadata = (_req: any, res: any) => {
    res.json({
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/authorize`,
      token_endpoint: `${config.publicUrl}/token`,
      registration_endpoint: `${config.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      code_challenge_methods_supported: ["S256", "plain"],
    });
  };
  router.get("/.well-known/oauth-authorization-server", authServerMetadata);
  router.get("/.well-known/oauth-authorization-server/mcp", authServerMetadata);
  router.get("/.well-known/openid-configuration", authServerMetadata);

  // Dynamic client registration (RFC 7591). Registrations are not retained:
  // client identity is not what secures this server — PKCE and the sealed
  // authorization code are — and retaining them would require shared storage.
  router.post("/register", (req, res) => {
    const { redirect_uris, client_name } = req.body;
    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString("hex");
    console.log(`[oauth] Registered client: ${client_name || clientId}`);
    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client_name || "MCP Client",
      redirect_uris: redirect_uris || [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
    });
  });

  // Authorization GET — redirect to Bouncie OAuth instead of showing a password form
  router.get("/authorize", (req, res) => {
    const {
      client_id,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
      response_type,
      scope,
    } = req.query as Record<string, string>;

    console.log(
      `[oauth] /authorize client=${client_id} scope=${scope || "none"} ` +
        `pkce=${code_challenge_method || "none"}`,
    );

    if (response_type !== "code") {
      res.status(400).send("Unsupported response_type");
      return;
    }
    if (!redirect_uri) {
      res.status(400).send("Missing redirect_uri");
      return;
    }

    // The pending flow travels as the `state` Bouncie will hand back to us.
    const sealedState = seal<PendingAuth>(
      "pending",
      {
        clientId: client_id,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        redirectUri: redirect_uri,
        mcpState: state,
        scope,
      },
      AUTH_FLOW_TTL_MS,
    );

    // Redirect user to Bouncie's authorization page
    const bouncieAuthUrl = new URL(BOUNCIE_AUTH_DIALOG);
    bouncieAuthUrl.searchParams.set("client_id", config.bouncieClientId);
    bouncieAuthUrl.searchParams.set("redirect_uri", `${config.publicUrl}/callback`);
    bouncieAuthUrl.searchParams.set("response_type", "code");
    bouncieAuthUrl.searchParams.set("state", sealedState);

    res.redirect(302, bouncieAuthUrl.toString());
  });

  // Bouncie OAuth callback — exchange Bouncie code, issue MCP auth code, redirect back to Claude.ai
  router.get("/callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      res.status(400).type("html").send(
        `<html><body><h1>Authorization Failed</h1><p>Bouncie returned an error: ${esc(error)}</p></body></html>`,
      );
      return;
    }

    const pending = unseal<PendingAuth>("pending", state);
    if (!pending) {
      res.status(400).type("html").send(
        `<html><body><h1>Invalid State</h1><p>OAuth state is invalid or expired. Please try again.</p></body></html>`,
      );
      return;
    }

    try {
      // Exchange Bouncie auth code for Bouncie access token
      const bouncieAccessToken = await exchangeBouncieCode(code, config);

      // Issue an MCP authorization code that carries the Bouncie token
      const mcpCode = seal<AuthCode>(
        "code",
        {
          clientId: pending.clientId,
          codeChallenge: pending.codeChallenge,
          codeChallengeMethod: pending.codeChallengeMethod,
          redirectUri: pending.redirectUri,
          bouncieAccessToken,
          scope: pending.scope,
        },
        AUTH_FLOW_TTL_MS,
      );

      // Redirect back to Claude.ai with the MCP auth code
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set("code", mcpCode);
      if (pending.mcpState) redirectUrl.searchParams.set("state", pending.mcpState);

      console.log(
        `[oauth] Bouncie authorization complete for client ${pending.clientId}; ` +
          `redirecting to ${pending.redirectUri}`,
      );
      res.redirect(302, redirectUrl.toString());
    } catch (err: any) {
      console.error(`[oauth] Bouncie token exchange failed: ${err.message}`);
      res.status(500).type("html").send(
        `<html><body><h1>Authorization Failed</h1><p>Failed to complete Bouncie authorization: ${esc(err.message)}</p></body></html>`,
      );
    }
  });

  // Token endpoint — exchange MCP auth code for MCP access token
  router.post("/token", (req, res) => {
    const { grant_type, code, code_verifier, redirect_uri } = req.body;

    const reject = (error: string, description: string) => {
      console.warn(`[oauth] /token rejected: ${error} — ${description}`);
      res.status(400).json({ error, error_description: description });
    };

    // Refresh grant — hand back a new access token for the same Bouncie session
    if (grant_type === "refresh_token") {
      const refresh = unseal<TokenPayload>("refresh", req.body.refresh_token);
      if (!refresh) {
        reject("invalid_grant", "refresh token is invalid or expired");
        return;
      }
      console.log(`[oauth] Refreshed access token for client ${refresh.clientId}`);
      res.json(issueTokens(refresh.clientId, refresh.bouncieAccessToken, refresh.scope));
      return;
    }

    if (grant_type !== "authorization_code") {
      reject("unsupported_grant_type", `grant_type was ${grant_type}`);
      return;
    }

    const stored = unseal<AuthCode>("code", code);
    if (!stored) {
      reject("invalid_grant", "authorization code is invalid or expired");
      return;
    }

    // PKCE verification
    if (stored.codeChallenge && stored.codeChallengeMethod) {
      let computedChallenge: string;
      if (stored.codeChallengeMethod === "S256") {
        computedChallenge = crypto
          .createHash("sha256")
          .update(code_verifier || "")
          .digest("base64url");
      } else {
        computedChallenge = code_verifier || "";
      }
      const a = Buffer.from(computedChallenge, "utf8");
      const b = Buffer.from(stored.codeChallenge, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        reject("invalid_grant", `PKCE verification failed (method ${stored.codeChallengeMethod})`);
        return;
      }
    }

    if (redirect_uri && redirect_uri !== stored.redirectUri) {
      reject("invalid_grant", `redirect_uri mismatch: got ${redirect_uri}, stored ${stored.redirectUri}`);
      return;
    }

    console.log(`[oauth] Issued access token for client ${stored.clientId}`);
    res.json(issueTokens(stored.clientId, stored.bouncieAccessToken, stored.scope));
  });

  /** Mint an access token (and a refresh token) bound to a Bouncie session. */
  function issueTokens(clientId: string, bouncieAccessToken: string, scope?: string) {
    const payload: TokenPayload = { clientId, bouncieAccessToken, scope };
    return {
      access_token: seal("access", payload, config.tokenTtlMs),
      token_type: "Bearer",
      expires_in: Math.floor(config.tokenTtlMs / 1000),
      // Refresh outlives the access token so a session survives a quiet period.
      refresh_token: seal("refresh", payload, 30 * 24 * 60 * 60 * 1000),
      ...(scope ? { scope } : {}),
    };
  }

  return router;
}
