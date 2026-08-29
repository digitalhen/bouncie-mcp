# CLAUDE.md — Bouncie MCP Server

## What this project is

An MCP server that wraps the Bouncie vehicle tracking REST API (`https://api.bouncie.dev/v1`). It exposes 6 tools: `get_vehicles`, `get_vehicle`, `get_trips`, `get_user`, `get_mileage_summary`, and `get_odometer_at`.

Supports two modes:
- **HTTP mode** (`src/http.ts`) — multi-user, centrally hosted. Each user authenticates with their own Bouncie account via OAuth. Designed for Claude.ai remote MCP.
- **Stdio mode** (`src/index.ts`) — single-user, local. Uses `BOUNCIE_ACCESS_TOKEN` env var.

## Hard constraint: the server is stateless

The reference deployment runs **two instances behind a load balancer that share
nothing** — no shared database, no shared volume, no session affinity. Any
request may land on either instance.

Nothing may be held in memory or on disk between requests. No `Map` of tokens, no
session registry, no JSON store on a volume. If you find yourself adding one, it
will work in testing and fail roughly half the time in production, and the
failures will look intermittent and unrelated to each other.

Instead, state travels inside the values handed to the client, sealed with
AES-256-GCM (`seal()` / `unseal()` in `src/oauth.ts`): the pending authorization
rides in the Bouncie `state` parameter, and the Bouncie access token rides inside
the MCP authorization code and the MCP access and refresh tokens. Each blob
carries a purpose label and an expiry. The key is derived by HKDF from
`TOKEN_SECRET`, falling back to `BOUNCIE_CLIENT_SECRET`, which is identical on
every instance by definition.

The MCP transport is stateless for the same reason (`sessionIdGenerator:
undefined`). `GET`/`DELETE /mcp` return 405, and an incoming `mcp-session-id` is
deleted rather than rejected.

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
  trips.ts       — trip range paging, chunk cache, local-time aggregation, bbox filtering
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
- **Trips:** GET `/v1/trips?imei=&startsAfter=&endsBefore=&gpsFormat=&transactionId=` — max 1 week window, `imei` required (not VIN)

### Upstream quirks that constrain the code

Verified empirically, not documented upstream. `src/trips.ts` depends on all of these:

- **`gpsFormat` is required.** Omitting it returns 400 `gpsFormat is a required field`. The server always sends one and strips the result when the caller did not ask for GPS.
- **In-progress trips return partial records** — no `endTime`, `distance`, speeds or `fuelConsumed`, and `endOdometer: null`. Never assume those fields exist; `isPartial()` guards every aggregate.
- **`startOdometer` is rounded, `endOdometer` is not.** A trip ending at `28062.2` is followed by one starting at `28062`. **Never derive distance by differencing odometers** — sum the exact `distance` field. Odometer is a coarse cross-check only.
- **Zero-distance trips are real idle events**, with nonzero `fuelConsumed` and large `totalIdleDuration`. Counted as `idle_events`, not `trip_count`, but their fuel and time still count.
- **`maxSpeed` is quantized to whole km/h**, so values like `62.137100000000004` are unit conversions, not precision. Round before displaying.
- **`transactionId` is `{imei}-{sequence}-{YYYYMM}`** and is the dedupe key across overlapping windows.

Distances and odometer are **miles**; `totalIdleDuration` is **seconds**.

### Geographic filtering

Trip records have **no lat/lon fields** — position exists only inside `gps`. Any
bbox filter must therefore fetch geometry (`needGps` in `fetchTripsRange`),
decode the polyline, test the box, then strip the geometry again unless the
caller asked for it. GPS-bearing chunks are cached under a `:gps` key suffix with
a much smaller entry budget, so they cannot displace the stripped chunks that
serve the common path.

A bbox-filtered summary totals the **whole** of each matching trip, including
distance driven outside the box. That is stated in the response `note`; do not
change it to clip distance without also changing that text.
- **User:** GET `/v1/user`

## Environment variables

### HTTP mode (multi-user)
- `BOUNCIE_CLIENT_ID` — Bouncie app client ID (required)
- `BOUNCIE_CLIENT_SECRET` — Bouncie app client secret (required)
- `PUBLIC_URL` — Public URL of this server, used for OAuth redirect_uri (default: `http://localhost:3000`)
- `PORT` — Listen port (default: `3000`)
- `TOKEN_TTL_HOURS` — MCP access token lifetime in hours (default: `24`)
- `TOKEN_SECRET` — key material for sealing tokens (default: derived from `BOUNCIE_CLIENT_SECRET`). Must be identical across instances. Rotating the effective key invalidates all outstanding MCP tokens — which is the only revocation mechanism, since nothing records that individual tokens exist.

The Bouncie OAuth redirect URI registered in your Bouncie app must be `{PUBLIC_URL}/callback`.

### Stdio mode (single-user)
- `BOUNCIE_ACCESS_TOKEN` — Pre-obtained Bouncie access token

## OAuth flow (HTTP mode)

1. Claude.ai discovers OAuth metadata at `/.well-known/oauth-authorization-server`
2. Claude.ai registers as a client via `/register`
3. User is redirected to `/authorize` → server redirects to Bouncie's OAuth
4. User authorizes with their Bouncie account
5. Bouncie redirects to `/callback` → server exchanges code for Bouncie token
6. Server issues an MCP auth code, redirects back to Claude.ai
7. Claude.ai exchanges the MCP code for an MCP access token at `/token`
8. Each MCP access token *contains* the user's Bouncie access token, sealed — it is not looked up

Client registrations at `/register` are **not retained**. Client identity is not
what secures this server; PKCE and the sealed authorization code are. Retaining
registrations would require shared storage, which the deployment does not have.

### Discovery endpoints clients actually require

Claude.ai will not complete a connection without these:

- `/.well-known/oauth-protected-resource` (RFC 9728), also under `/mcp`
- `/.well-known/oauth-authorization-server` (RFC 8414), also under `/mcp`
- a `WWW-Authenticate: Bearer resource_metadata="..."` header on every 401 from `/mcp`

Do not advertise `scopes_supported` unless the scopes are real. Advertising an
invented scope makes clients request a grant this server cannot honour.

## Testing approach

Tests mock `globalThis.fetch` — no real API calls. Integration tests use `InMemoryTransport` from the MCP SDK to test the full tool → client → API → response pipeline.
