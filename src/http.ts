#!/usr/bin/env node

import express from "express";
import crypto from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { createOAuthRouter, isValidToken } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const OAUTH_PASSWORD = process.env.OAUTH_PASSWORD;
const TOKEN_TTL_HOURS = parseInt(process.env.TOKEN_TTL_HOURS || "24", 10);

if (!OAUTH_PASSWORD) {
  console.error("Missing required OAUTH_PASSWORD environment variable");
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

// OAuth routes
app.use(createOAuthRouter({
  publicUrl: PUBLIC_URL,
  oauthPassword: OAUTH_PASSWORD,
  tokenTtlMs: TOKEN_TTL_HOURS * 60 * 60 * 1000,
}));

// Bearer token auth for /mcp
app.use("/mcp", (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!isValidToken(auth.slice(7))) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
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

  const mcpServer = createServer();
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

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session" });
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session" });
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
  console.log(`OAuth endpoints: /authorize, /token, /register`);
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
