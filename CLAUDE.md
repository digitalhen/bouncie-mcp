# CLAUDE.md — Bouncie MCP Server

## What this project is

An MCP server that wraps the Bouncie vehicle tracking REST API (`https://api.bouncie.dev/v1`). It exposes 4 tools: `get_vehicles`, `get_vehicle`, `get_trips`, `get_user`.

## Tech stack

- TypeScript, Node.js (ESM)
- `@modelcontextprotocol/sdk` for MCP protocol
- `vitest` for testing
- No other runtime dependencies — uses native `fetch`

## Project structure

```
src/
  index.ts       — MCP server entry point, tool definitions
  api.ts         — BouncieClient class (REST API + OAuth)
  types.ts       — TypeScript types for all API objects and webhook events
  api.test.ts    — Unit tests for BouncieClient
  index.test.ts  — Integration tests (MCP tools via in-memory transport)
```

## Key commands

```bash
npm run build      # tsc → dist/
npm test           # vitest run (21 tests)
npm run dev        # tsx src/index.ts
npm run lint       # tsc --noEmit
```

## API details

- **Auth:** POST `https://auth.bouncie.com/oauth/token` with `client_id`, `client_secret`, `grant_type=authorization_code`, `code`, `redirect_uri`. Returns `access_token`.
- **Vehicles:** GET `/v1/vehicles?imei=&vin=` with `Authorization: <token>` header
- **Trips:** GET `/v1/trips?imei=&startsAfter=&endsBefore=&gpsFormat=&transactionId=` — max 1 week window
- **User:** GET `/v1/user`

## Environment variables

All required at runtime: `BOUNCIE_CLIENT_ID`, `BOUNCIE_CLIENT_SECRET`, `BOUNCIE_REDIRECT_URI`. Plus one of `BOUNCIE_ACCESS_TOKEN` or `BOUNCIE_AUTH_CODE`.

## Testing approach

Tests mock `globalThis.fetch` — no real API calls. Integration tests use `InMemoryTransport` from the MCP SDK to test the full tool → client → API → response pipeline.
