#!/usr/bin/env node

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { createOAuthRouter, isValidToken, getBouncieToken } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const TOKEN_TTL_HOURS = parseInt(process.env.TOKEN_TTL_HOURS || "24", 10);
// Optional explicit key for sealing tokens. Left unset, it is derived from the
// Bouncie client secret, which is identical across instances by definition.
const TOKEN_SECRET = process.env.TOKEN_SECRET;

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
  tokenSecret: TOKEN_SECRET,
}));

// Bearer token auth for /mcp — extract Bouncie token for the session
const RESOURCE_METADATA_URL = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

app.use("/mcp", (req, res, next) => {
  // The MCP auth spec requires 401s to point at the protected-resource metadata,
  // which is how the client discovers where to start the OAuth flow.
  const challenge = (error: string, description: string) => {
    const a = req.headers.authorization;
    console.warn(
      `[mcp] 401 ${req.method} /mcp: ${description} ` +
        `(bearer=${a ? a.slice(7, 17) + "…" : "ABSENT"})`,
    );
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
// MCP transport — stateless
//
// This service runs on more than one host behind a load balancer, so a session
// pinned to one process's memory would break as soon as the next request landed
// elsewhere. Each request is handled on its own transport instead, which any
// instance can serve.
// ---------------------------------------------------------------------------

app.post("/mcp", async (req, res) => {
  // A client may still present a session id from an earlier connection. There
  // are no sessions here, so ignore it rather than rejecting the request and
  // making the client retry.
  delete req.headers["mcp-session-id"];

  const bouncieAccessToken = (req as any).bouncieAccessToken as string | undefined;
  const mcpServer = createServer({ bouncieAccessToken: bouncieAccessToken ?? undefined });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    mcpServer.close().catch(() => {});
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err: any) {
    console.error(`[mcp] POST /mcp failed: ${err?.stack || err?.message || err}`);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
  }
});

// No server-initiated streams and no sessions to terminate in stateless mode.
const notAllowed = (_req: express.Request, res: express.Response) => {
  res.setHeader("Allow", "POST");
  res.status(405).json({ error: "Method Not Allowed" });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
