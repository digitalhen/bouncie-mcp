# CLAUDE.md — Bouncie MCP Server

## What this project is

An MCP server that wraps the Bouncie vehicle tracking REST API (`https://api.bouncie.dev/v1`). It exposes 4 tools: `get_vehicles`, `get_vehicle`, `get_trips`, `get_user`.

Supports two modes:
- **HTTP mode** (`src/http.ts`) — multi-user, centrally hosted. Each user authenticates with their own Bouncie account via OAuth. Designed for Claude.ai remote MCP.
- **Stdio mode** (`src/index.ts`) — single-user, local. Uses `BOUNCIE_ACCESS_TOKEN` env var.

## Tech stack

- TypeScript, Node.js (ESM)
- `@modelcontextprotocol/sdk` for MCP protocol
- `express` for HTTP server + OAuth endpoints
- `vitest` for testing

## Project structure

```
src/
  index.ts       — Stdio MCP entry point (local/dev use)
  http.ts        — HTTP MCP entry point (multi-user, production)
  server.ts      — MCP tool definitions (shared by both entry points)
  api.ts         — BouncieClient class (REST API calls)
  oauth.ts       — OAuth provider that proxies to Bouncie OAuth
  types.ts       — TypeScript types for all API objects and webhook events
  api.test.ts    — Unit tests for BouncieClient
  index.test.ts  — Integration tests (MCP tools via in-memory transport)
```

## Key commands

```bash
npm run build      # tsc → dist/
npm test           # vitest run (21 tests)
npm run dev        # tsx src/index.ts (stdio mode)
npm run lint       # tsc --noEmit
```

## API details

- **Auth:** POST `https://auth.bouncie.com/oauth/token` with `client_id`, `client_secret`, `grant_type=authorization_code`, `code`, `redirect_uri`. Returns `access_token`.
- **Vehicles:** GET `/v1/vehicles?imei=&vin=` with `Authorization: <token>` header
- **Trips:** GET `/v1/trips?imei=&startsAfter=&endsBefore=&gpsFormat=&transactionId=` — max 1 week window
- **User:** GET `/v1/user`

## Environment variables

### HTTP mode (multi-user)
- `BOUNCIE_CLIENT_ID` — Bouncie app client ID (required)
- `BOUNCIE_CLIENT_SECRET` — Bouncie app client secret (required)
- `PUBLIC_URL` — Public URL of this server, used for OAuth redirect_uri (default: `http://localhost:3000`)
- `PORT` — Listen port (default: `3000`)
- `TOKEN_TTL_HOURS` — MCP token lifetime in hours (default: `24`)

The Bouncie OAuth redirect URI registered in your Bouncie app must be `{PUBLIC_URL}/auth/bouncie/callback`.

### Stdio mode (single-user)
- `BOUNCIE_ACCESS_TOKEN` — Pre-obtained Bouncie access token

## OAuth flow (HTTP mode)

1. Claude.ai discovers OAuth metadata at `/.well-known/oauth-authorization-server`
2. Claude.ai registers as a client via `/register`
3. User is redirected to `/authorize` → server redirects to Bouncie's OAuth
4. User authorizes with their Bouncie account
5. Bouncie redirects to `/auth/bouncie/callback` → server exchanges code for Bouncie token
6. Server issues an MCP auth code, redirects back to Claude.ai
7. Claude.ai exchanges the MCP code for an MCP access token at `/token`
8. Each MCP access token is tied to the user's Bouncie access token

## Testing approach

Tests mock `globalThis.fetch` — no real API calls. Integration tests use `InMemoryTransport` from the MCP SDK to test the full tool → client → API → response pipeline.
