#!/usr/bin/env node

import express from "express";
import crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { createOAuthRouter, isValidToken, getBouncieToken } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const TOKEN_TTL_HOURS = parseInt(process.env.TOKEN_TTL_HOURS || "24", 10);
// Keep the OAuth store off the image layer so redeploys don't sign everyone out
// or strand users part-way through the authorization flow.
const DATA_DIR = process.env.DATA_DIR || process.cwd();

const BOUNCIE_CLIENT_ID = process.env.BOUNCIE_CLIENT_ID;
const BOUNCIE_CLIENT_SECRET = process.env.BOUNCIE_CLIENT_SECRET;

if (!BOUNCIE_CLIENT_ID || !BOUNCIE_CLIENT_SECRET) {
  console.error("Missing required BOUNCIE_CLIENT_ID and/or BOUNCIE_CLIENT_SECRET environment variables");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Parse JSON/form bodies everywhere EXCEPT /mcp
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/mcp") return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// OAuth routes — Bouncie OAuth proxy
app.use(createOAuthRouter({
  publicUrl: PUBLIC_URL,
  tokenTtlMs: TOKEN_TTL_HOURS * 60 * 60 * 1000,
  bouncieClientId: BOUNCIE_CLIENT_ID,
  bouncieClientSecret: BOUNCIE_CLIENT_SECRET,
}, DATA_DIR));

// Bearer token auth for /mcp — extract Bouncie token for the session
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

app.use("/mcp", (req, res, next) => {
  console.log(
    `[mcp] ${req.method} /mcp session=${req.headers["mcp-session-id"] || "none"} ` +
      `auth=${req.headers.authorization ? "present" : "MISSING"} ` +
      `accept=${req.headers.accept || "none"}`,
  );

  // The MCP auth spec requires 401s to point at the protected-resource metadata,
  // which is how the client discovers where to start the OAuth flow.
  const challenge = (error: string, description: string) => {
    console.warn(`[mcp] 401 on ${req.method} /mcp: ${description}`);
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}", error="${error}", error_description="${description}"`,
    );
    res.status(401).json({ error: description });
  };

  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    challenge("invalid_request", "Unauthorized");
    return;
  }
  const mcpToken = auth.slice(7);
  if (!isValidToken(mcpToken)) {
    challenge("invalid_token", "Invalid or expired token");
    return;
  }
  // Attach Bouncie token to request for downstream use
  (req as any).bouncieAccessToken = getBouncieToken(mcpToken);
  next();
});

// ---------------------------------------------------------------------------
// MCP transport management
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

function cleanupTransport(sessionId: string) {
  const transport = transports.get(sessionId);
  if (transport) {
    transports.delete(sessionId);
    console.log(`[mcp] Session closed: ${sessionId}`);
  }
}

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  // Create a new MCP server with this user's Bouncie token
  const bouncieAccessToken = (req as any).bouncieAccessToken as string | undefined;
  const mcpServer = createServer({ bouncieAccessToken: bouncieAccessToken ?? undefined });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
      console.log(`[mcp] Session created: ${sid}`);
    },
  });

  transport.onclose = () => {
    const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0];
    if (sid) cleanupTransport(sid);
  };

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err: any) {
    console.error(`[mcp] POST /mcp failed: ${err?.stack || err?.message || err}`);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    // A client may open an SSE stream before it holds a session. That is not an
    // error worth failing the connection over — say the method isn't available.
    console.warn(`[mcp] GET /mcp with no live session (${sessionId || "none"}) — 405`);
    res.setHeader("Allow", "POST, DELETE");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    console.warn(`[mcp] DELETE /mcp with no live session (${sessionId || "none"})`);
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    sessions: transports.size,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Bouncie MCP listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(`OAuth: users authorize via Bouncie at /authorize`);
  console.log(`Public URL: ${PUBLIC_URL}`);
});

function shutdown(signal: string) {
  console.log(`${signal} — shutting down`);
  for (const [sid, transport] of transports) {
    try { transport.close?.(); } catch {}
    transports.delete(sid);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
