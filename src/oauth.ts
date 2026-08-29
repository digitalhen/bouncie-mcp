// ---------------------------------------------------------------------------
// OAuth 2.0 — Bouncie OAuth proxy for Claude.ai hosted MCP
//
// Instead of a password gate, users authorize with their own Bouncie account.
// The MCP server acts as an OAuth provider to Claude.ai while proxying
// authorization to Bouncie's OAuth under the hood.
// ---------------------------------------------------------------------------

import { Router } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Persistent stores — backed by a JSON file on disk
// ---------------------------------------------------------------------------

interface AuthCode {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri: string;
  bouncieAccessToken: string;
  expiresAt: number;
  scope?: string;
}

interface TokenRecord {
  clientId: string;
  bouncieAccessToken: string;
  issuedAt: number;
  expiresAt: number;
  scope?: string;
}

interface RefreshRecord {
  clientId: string;
  bouncieAccessToken: string;
  scope?: string;
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

/** Pending Bouncie OAuth flow — maps our internal state to the original Claude.ai OAuth params */
interface PendingBouncieAuth {
  clientId: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri: string;
  mcpState?: string;
  scope?: string;
  createdAt: number;
}

interface StoreData {
  accessTokens: Record<string, TokenRecord>;
  registeredClients: Record<string, RegisteredClient>;
  /** In-flight authorization codes and pending Bouncie redirects. These are
   *  short-lived, but a restart mid-flow must not strand a user who is part-way
   *  through authorizing — deploys are frequent enough to hit that window. */
  authCodes?: Record<string, AuthCode>;
  pendingBouncieAuths?: Record<string, PendingBouncieAuth>;
  refreshTokens?: Record<string, RefreshRecord>;
}

const authCodes = new Map<string, AuthCode>();
const accessTokens = new Map<string, TokenRecord>();
const registeredClients = new Map<string, RegisteredClient>();
const pendingBouncieAuths = new Map<string, PendingBouncieAuth>();
const refreshTokens = new Map<string, RefreshRecord>();

let storePath = "";

function initStore(dataDir: string) {
  storePath = path.join(dataDir, "oauth-store.json");
  try {
    if (fs.existsSync(storePath)) {
      const raw: StoreData = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw.accessTokens || {})) {
        if (v.expiresAt > now) accessTokens.set(k, v);
      }
      for (const [k, v] of Object.entries(raw.registeredClients || {})) {
        registeredClients.set(k, v);
      }
      for (const [k, v] of Object.entries(raw.authCodes || {})) {
        if (v.expiresAt > now) authCodes.set(k, v);
      }
      for (const [k, v] of Object.entries(raw.pendingBouncieAuths || {})) {
        if (now - v.createdAt < 10 * 60 * 1000) pendingBouncieAuths.set(k, v);
      }
      for (const [k, v] of Object.entries(raw.refreshTokens || {})) {
        refreshTokens.set(k, v);
      }
      console.log(
        `[oauth] Restored ${accessTokens.size} tokens, ${registeredClients.size} clients, ` +
          `${authCodes.size} auth codes, ${pendingBouncieAuths.size} pending auths from disk`,
      );
    }
  } catch (err: any) {
    console.warn(`[oauth] Failed to load OAuth store: ${err.message}`);
  }
}

function saveStore() {
  try {
    const data: StoreData = {
      accessTokens: Object.fromEntries(accessTokens),
      registeredClients: Object.fromEntries(registeredClients),
      authCodes: Object.fromEntries(authCodes),
      pendingBouncieAuths: Object.fromEntries(pendingBouncieAuths),
      refreshTokens: Object.fromEntries(refreshTokens),
    };
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err: any) {
    console.error(`[oauth] Failed to save OAuth store: ${err.message}`);
  }
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [code, data] of authCodes) {
    if (data.expiresAt < now) {
      authCodes.delete(code);
      changed = true;
    }
  }
  for (const [token, data] of accessTokens) {
    if (data.expiresAt < now) {
      accessTokens.delete(token);
      changed = true;
    }
  }
  // Clean up expired pending Bouncie auths (10 min TTL)
  for (const [state, data] of pendingBouncieAuths) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      pendingBouncieAuths.delete(state);
      changed = true;
    }
  }
  if (changed) saveStore();
}, 60_000);

// ---------------------------------------------------------------------------
// Token validation & Bouncie token lookup — used by MCP auth middleware
// ---------------------------------------------------------------------------

export function isValidToken(token: string): boolean {
  const record = accessTokens.get(token);
  if (!record) return false;
  if (record.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

/** Look up the Bouncie access token associated with an MCP bearer token */
export function getBouncieToken(mcpToken: string): string | null {
  const record = accessTokens.get(mcpToken);
  if (!record) return null;
  if (record.expiresAt < Date.now()) {
    accessTokens.delete(mcpToken);
    return null;
  }
  return record.bouncieAccessToken;
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
}

// ---------------------------------------------------------------------------
// Bouncie OAuth helpers
// ---------------------------------------------------------------------------

const BOUNCIE_AUTH_DIALOG = "https://auth.bouncie.com/dialog/authorize";
const BOUNCIE_TOKEN_URL = "https://auth.bouncie.com/oauth/token";

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

export function createOAuthRouter(config: OAuthConfig, dataDir?: string): Router {
  initStore(dataDir || process.cwd());
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
      scopes_supported: ["bouncie"],
    });
  };
  router.get("/.well-known/oauth-authorization-server", authServerMetadata);
  router.get("/.well-known/oauth-authorization-server/mcp", authServerMetadata);
  router.get("/.well-known/openid-configuration", authServerMetadata);

  // Dynamic client registration (RFC 7591)
  router.post("/register", (req, res) => {
    const { redirect_uris, client_name } = req.body;
    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString("hex");
    registeredClients.set(clientId, {
      clientId,
      clientSecret,
      redirectUris: redirect_uris || [],
    });
    saveStore();
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

    // Generate internal state for the Bouncie OAuth flow
    const internalState = crypto.randomBytes(16).toString("hex");
    pendingBouncieAuths.set(internalState, {
      clientId: client_id,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      redirectUri: redirect_uri,
      mcpState: state,
      scope,
      createdAt: Date.now(),
    });
    saveStore();

    // Redirect user to Bouncie's authorization page
    const bouncieAuthUrl = new URL(BOUNCIE_AUTH_DIALOG);
    bouncieAuthUrl.searchParams.set("client_id", config.bouncieClientId);
    bouncieAuthUrl.searchParams.set("redirect_uri", `${config.publicUrl}/callback`);
    bouncieAuthUrl.searchParams.set("response_type", "code");
    bouncieAuthUrl.searchParams.set("state", internalState);

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

    const pending = pendingBouncieAuths.get(state);
    if (!pending) {
      res.status(400).type("html").send(
        `<html><body><h1>Invalid State</h1><p>OAuth state is invalid or expired. Please try again.</p></body></html>`,
      );
      return;
    }
    pendingBouncieAuths.delete(state);
    saveStore();

    try {
      // Exchange Bouncie auth code for Bouncie access token
      const bouncieAccessToken = await exchangeBouncieCode(code, config);

      // Issue an MCP authorization code that carries the Bouncie token
      const mcpCode = crypto.randomBytes(32).toString("hex");
      authCodes.set(mcpCode, {
        clientId: pending.clientId,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: pending.codeChallengeMethod,
        redirectUri: pending.redirectUri,
        bouncieAccessToken,
        scope: pending.scope,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      saveStore();

      // Redirect back to Claude.ai with the MCP auth code
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set("code", mcpCode);
      if (pending.mcpState) redirectUrl.searchParams.set("state", pending.mcpState);

      console.log(
        `[oauth] Bouncie authorization complete for client ${pending.clientId}; ` +
          `redirecting to ${pending.redirectUri} state=${pending.mcpState ? "present" : "MISSING"}`,
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
      const refresh = refreshTokens.get(req.body.refresh_token);
      if (!refresh) {
        reject("invalid_grant", "unknown refresh token");
        return;
      }
      const issued = issueTokens(refresh.clientId, refresh.bouncieAccessToken, refresh.scope);
      console.log(`[oauth] Refreshed access token for client ${refresh.clientId}`);
      res.json(issued);
      return;
    }

    if (grant_type !== "authorization_code") {
      reject("unsupported_grant_type", `grant_type was ${grant_type}`);
      return;
    }

    const stored = authCodes.get(code);
    if (!stored) {
      reject("invalid_grant", `no such authorization code (${authCodes.size} outstanding)`);
      return;
    }
    if (stored.expiresAt < Date.now()) {
      authCodes.delete(code);
      reject("invalid_grant", "authorization code expired");
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

    authCodes.delete(code);
    const issued = issueTokens(stored.clientId, stored.bouncieAccessToken, stored.scope);
    console.log(`[oauth] Issued access token for client ${stored.clientId}`);
    res.json(issued);
  });

  /** Mint an access token (and a refresh token) bound to a Bouncie session. */
  function issueTokens(clientId: string, bouncieAccessToken: string, scope?: string) {
    const token = crypto.randomBytes(32).toString("hex");
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    accessTokens.set(token, {
      clientId,
      bouncieAccessToken,
      scope,
      issuedAt: now,
      expiresAt: now + config.tokenTtlMs,
    });
    refreshTokens.set(refreshToken, { clientId, bouncieAccessToken, scope });
    saveStore();
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.floor(config.tokenTtlMs / 1000),
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    };
  }

  return router;
}
