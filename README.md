<p align="center">
  <img src="branding/logo.png" alt="Bouncie Copilot" width="480"/>
</p>

# Bouncie MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [Bouncie](https://bouncie.com) OBD2 vehicle tracking API. Give Claude, ChatGPT, or any MCP-compatible AI assistant real-time access to your vehicle data — location, trips, diagnostics, fuel level, and more.

## What it does

Connect your Bouncie GPS tracker to AI. Ask natural language questions like:

- "Where is my car right now?"
- "Show me my trips from last week"
- "Is my check engine light on? What codes?"
- "How much fuel do I have left?"
- "What was my longest drive this week?"

## Features

- **Real-time vehicle tracking** — GPS location, speed, heading, address
- **Trip history & analytics** — distance, duration, average/max speed, fuel consumed, hard braking & acceleration counts, GPS traces (polyline or GeoJSON)
- **Vehicle diagnostics** — check engine light (MIL) status, OBD2 diagnostic trouble codes (DTCs), battery health
- **Vehicle info** — make, model, year, VIN, engine, odometer, fuel level
- **Multi-user OAuth** — HTTP mode proxies Claude.ai's OAuth to Bouncie's, so each user authorizes with their own Bouncie account
- **Stdio + HTTP modes** — run locally with a pre-issued access token, or host centrally for multiple users
- **Stateless — safe behind a load balancer** — no session or token state is held in memory or on disk, so any instance can serve any request
- **Docker-ready** — deploy anywhere with HTTPS

## Quick Start

### Local (stdio) mode

```bash
npm install && npm run build
```

Add to Claude Desktop or Claude Code MCP settings:

```json
{
  "mcpServers": {
    "bouncie": {
      "command": "node",
      "args": ["/path/to/bouncie-mcp/dist/index.js"],
      "env": {
        "BOUNCIE_ACCESS_TOKEN": "your-access-token"
      }
    }
  }
}
```

Stdio mode uses a pre-obtained Bouncie access token — no OAuth flow. Use HTTP mode for multi-user deployments.

### Remote (HTTP) mode with Docker

```bash
cp .env.example .env  # fill in your credentials
docker compose up -d
```

The server exposes:
- `/mcp` — MCP endpoint (Bearer token auth)
- `/authorize` — kicks off the OAuth flow, redirects the user to Bouncie
- `/callback` — Bouncie's OAuth redirect target
- `/token` — token exchange endpoint for MCP clients
- `/register` — RFC 7591 dynamic client registration
- `/.well-known/oauth-authorization-server` — RFC 8414 authorization server metadata
- `/.well-known/oauth-protected-resource` — RFC 9728 protected resource metadata
- `/health` — health check

Both `.well-known` documents are also served under a `/mcp` suffix, which is where
clients probe when the resource has a path component.

## Bouncie App Setup

1. Register at [bouncie.dev](https://www.bouncie.dev) and create an app
2. Note your **Client ID** and **Client Secret**
3. Set the **Redirect URL** to `{PUBLIC_URL}/callback` (e.g. `https://bouncie.example.com/callback`)

That's all the portal work — users authorize individually through the OAuth flow when they connect via Claude.ai.

## Environment Variables

### Stdio mode (single-user)

| Variable | Required | Description |
|---|---|---|
| `BOUNCIE_ACCESS_TOKEN` | Yes | Pre-obtained Bouncie access token |

### HTTP mode (multi-user)

| Variable | Required | Description |
|---|---|---|
| `BOUNCIE_CLIENT_ID` | Yes | Bouncie app client ID |
| `BOUNCIE_CLIENT_SECRET` | Yes | Bouncie app client secret |
| `PUBLIC_URL` | Yes | Public URL (e.g. `https://bouncie.example.com`); Bouncie app's redirect URL must be `{PUBLIC_URL}/callback` |
| `TOKEN_TTL_HOURS` | No | MCP access token lifetime in hours, default 24 |
| `TRIP_THROTTLE_MS` | No | Delay between upstream `/trips` calls, default 250. A 13-month summary is ~63 windows, so a first uncached query takes roughly `windows × this`. Lower it if your client's timeout is tighter than Bouncie's rate limit demands |
| `TOKEN_SECRET` | No | Key material for sealing tokens. Defaults to deriving from `BOUNCIE_CLIENT_SECRET`. Set it explicitly if you run multiple instances and want token lifetime decoupled from client secret rotation — see [Running more than one instance](#running-more-than-one-instance) |
| `PORT` | No | HTTP server port, default 3000 |

## Tools

### `get_vehicles`

List all vehicles on the account with live stats.

| Parameter | Type | Description |
|---|---|---|
| `vin` | string (optional) | Filter by VIN |
| `imei` | string (optional) | Filter by device IMEI |

Returns: vehicle info (make/model/year, VIN, IMEI, nickname) and live stats (GPS location, speed, fuel level, odometer, engine running status, battery, check engine light, DTCs).

### `get_vehicle`

Get a single vehicle by VIN or IMEI. At least one identifier required.

### `get_trips`

Get individual trips for a vehicle.

| Parameter | Type | Description |
|---|---|---|
| `imei` | string | Device IMEI (required) |
| `starts_after` | string (optional) | ISO date — trips starting after this time |
| `ends_before` | string (optional) | ISO date — trips ending before this time |
| `include_gps` | boolean (optional) | Include route geometry. **Default `false`** |
| `gps_format` | `"polyline"` \| `"geojson"` (optional) | Format when `include_gps` is true (default: polyline) |
| `transaction_id` | string (optional) | Fetch a specific trip by transaction ID |

> Date window max 1 week. Defaults to last 7 days.

Returns: distance, duration, average/max speed, fuel consumed, hard braking/acceleration counts, odometer.

**GPS is excluded unless you ask for it.** Route geometry is roughly 90% of a
typical response, and most questions don't need it. The upstream API requires a
`gpsFormat` on every request, so the server always sends one and strips the
result when `include_gps` is false.

For anything spanning more than a week, use `get_mileage_summary` rather than
paging this tool.

### `get_mileage_summary`

Driving totals over any date range, bucketed by day, week, month, or year. This
is the tool for trend questions — monthly series, before/after comparisons,
year-over-year — which are impractical to answer by paging `get_trips`.

| Parameter | Type | Description |
|---|---|---|
| `imei` | string | Device IMEI (required) |
| `since` | string | Start of range, inclusive (`YYYY-MM-DD`) |
| `until` | string | End of range, inclusive (`YYYY-MM-DD`) |
| `period` | `"day"` \| `"week"` \| `"month"` \| `"year"` (optional) | Bucket size (default: month) |

Returns a bucket per non-empty period plus a `totals` block, a `partial_trips`
count, and `warnings` if any window could not be fetched. Contains no GPS data.

| Field | Meaning |
|---|---|
| `trip_count` | Moving trips only |
| `idle_events` | Zero-distance records — real fuel burn, counted separately so they don't inflate `trip_count` |
| `distance_mi` / `distance_km` | Summed from each trip's exact `distance` |
| `fuel_consumed_gal` | Includes fuel burned during idle events |
| `duration_min` | Total trip time |
| `driving_time_min` / `idle_time_min` | Moving vs. stopped, within trips |
| `avg_speed_mph` / `avg_speed_kmh` | Distance over **moving** time, excluding idle |
| `hard_braking` / `hard_acceleration` | Event counts |

Notes on correctness:

- Trips are bucketed by the vehicle's **local** date, using each trip's own
  `timeZone` offset. A 9pm trip on the last day of a month stays in that month.
- Distances are summed from the per-trip `distance` field, **never** by
  differencing odometer readings — `startOdometer` is rounded to whole miles
  while `endOdometer` is not, so consecutive trips disagree at the seam.
- Trips still in progress are excluded from totals and reported in
  `partial_trips`.
- Both metric and imperial units are emitted, matching the shape of the e-bike
  MCP's `mileage_over_time` so the two series can be compared field for field.

### `get_odometer_at`

The odometer reading at or before a given moment, from the most recent completed
trip. Searches backward up to 30 days.

| Parameter | Type | Description |
|---|---|---|
| `imei` | string | Device IMEI (required) |
| `date` | string | Point in time (`YYYY-MM-DD` or ISO datetime) |

Returns `odometer_mi` (from the unrounded `endOdometer`), `reading_time`,
`local_time`, `source_transaction_id`, and `gap_hours` — how far before the
requested time the reading actually is, so you can judge whether it's close
enough to be meaningful.

### `get_user`

Get the authenticated user's profile.

## Timestamps

All timestamps from the Bouncie API are in **UTC**. Each vehicle/trip includes a timezone offset field (`localTimeZone` or `timeZone`, e.g. `"-0500"`) for local time conversion.

## Development

```bash
npm run dev        # Run with tsx (hot reload)
npm run build      # Compile TypeScript
npm test           # Run tests (59 tests)
npm run lint       # Type check
```

## Architecture

- `src/index.ts` — stdio transport entry point
- `src/http.ts` — HTTP/Express entry point with OAuth
- `src/server.ts` — MCP tool definitions
- `src/api.ts` — Bouncie REST API client
- `src/trips.ts` — trip range paging, caching, and aggregation
- `src/oauth.ts` — OAuth provider that proxies Claude.ai's OAuth to Bouncie's (PKCE supported)
- `src/types.ts` — TypeScript types for vehicles, trips, and webhook events

### Running more than one instance

This server holds **no state** — not in memory, not on disk. That is a deliberate
design constraint, not an incidental property, because the reference deployment
runs two instances behind a load balancer that shares nothing between them.

Everything the server would otherwise need to remember is carried inside the
values it hands out, sealed with AES-256-GCM:

| Value | Carries | Lifetime |
|---|---|---|
| Bouncie `state` parameter | the pending authorization (client, PKCE challenge, redirect URI, client's own state) | 10 min |
| MCP authorization code | Bouncie access token, PKCE challenge, redirect URI | 10 min |
| MCP access token | Bouncie access token | `TOKEN_TTL_HOURS`, default 24h |
| MCP refresh token | Bouncie access token | 30 days |

Each blob carries a purpose label and an expiry, and is rejected if either fails.
The sealing key is derived via HKDF from `TOKEN_SECRET`, or from
`BOUNCIE_CLIENT_SECRET` when that is unset — a value every instance already
shares, so a multi-instance deployment needs no extra configuration.

The MCP transport is stateless for the same reason: a session pinned to one
process breaks as soon as the next request lands on another instance. `GET` and
`DELETE /mcp` therefore return 405, and an `mcp-session-id` header from a
client's earlier connection is ignored rather than rejected.

For the debugging history behind this design, see
[docs/oauth-debugging-notes.md](docs/oauth-debugging-notes.md).

**Two consequences worth knowing:**

- Rotating `BOUNCIE_CLIENT_SECRET` invalidates every outstanding MCP token, since
  the sealing key derives from it. Set `TOKEN_SECRET` explicitly to decouple them.
- Individual tokens cannot be revoked, because nothing records that they exist.
  Rotating the sealing key revokes all of them at once.

## Bouncie Webhook Events

The Bouncie API also supports webhooks (documented here for reference):

| Event | Description |
|---|---|
| `connect` / `disconnect` | Device plugged in / unplugged |
| `battery` | Battery status change (normal/critical) |
| `mil` | Check engine light on/off with DTC codes |
| `tripStart` / `tripEnd` | Trip begins/ends with odometer, fuel consumed |
| `tripMetrics` | Trip summary — distance, speeds, braking/acceleration |
| `tripData` | Real-time GPS breadcrumbs during a trip |

## License

MIT
