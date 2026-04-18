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
- **OAuth 2.0 + PKCE** — secure authentication for hosted/remote deployments (compatible with Claude.ai)
- **Docker + Cloudflare Tunnel ready** — deploy anywhere with HTTPS

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
        "BOUNCIE_CLIENT_ID": "your-client-id",
        "BOUNCIE_CLIENT_SECRET": "your-client-secret",
        "BOUNCIE_REDIRECT_URI": "https://example.com/callback",
        "BOUNCIE_ACCESS_TOKEN": "your-access-token"
      }
    }
  }
}
```

### Remote (HTTP) mode with Docker

```bash
cp .env.example .env  # fill in your credentials
docker compose up -d
```

The server exposes:
- `/mcp` — MCP endpoint (Bearer token auth)
- `/authorize` — OAuth login page
- `/health` — health check
- `/.well-known/oauth-authorization-server` — RFC 8414 metadata

## Bouncie API Credentials

1. Register at [bouncie.dev](https://www.bouncie.dev) and create an app
2. Note your **Client ID** and **Client Secret**
3. Set a **Redirect URI**
4. Under "Users & Devices", authorize your account
5. Copy the **Authorization Code** from the device's expanded view

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BOUNCIE_CLIENT_ID` | Yes | Bouncie app client ID |
| `BOUNCIE_CLIENT_SECRET` | Yes | Bouncie app client secret |
| `BOUNCIE_REDIRECT_URI` | Yes | Redirect URI from app registration |
| `BOUNCIE_AUTH_CODE` | One of these | Authorization code (auto-exchanged for token) |
| `BOUNCIE_ACCESS_TOKEN` | One of these | Pre-obtained access token |
| `PUBLIC_URL` | HTTP mode | Public URL (e.g. `https://bouncie.example.com`) |
| `OAUTH_PASSWORD` | HTTP mode | Password for the OAuth authorization form |
| `TOKEN_TTL_HOURS` | No | OAuth token lifetime, default 24 |
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

Get trip history for a vehicle.

| Parameter | Type | Description |
|---|---|---|
| `imei` | string | Device IMEI (required) |
| `starts_after` | string (optional) | ISO date — trips starting after this time |
| `ends_before` | string (optional) | ISO date — trips ending before this time |
| `gps_format` | `"polyline"` \| `"geojson"` (optional) | GPS data format (default: polyline) |
| `transaction_id` | string (optional) | Fetch a specific trip by transaction ID |

> Date window max 1 week. Defaults to last 7 days.

Returns: distance, duration, average/max speed, fuel consumed, hard braking/acceleration counts, odometer, GPS trace.

### `get_user`

Get the authenticated user's profile.

## Timestamps

All timestamps from the Bouncie API are in **UTC**. Each vehicle/trip includes a timezone offset field (`localTimeZone` or `timeZone`, e.g. `"-0500"`) for local time conversion.

## Development

```bash
npm run dev        # Run with tsx (hot reload)
npm run build      # Compile TypeScript
npm test           # Run tests (21 tests)
npm run lint       # Type check
```

## Architecture

- `src/index.ts` — stdio transport entry point
- `src/http.ts` — HTTP/Express entry point with OAuth
- `src/server.ts` — MCP tool definitions
- `src/api.ts` — Bouncie REST API client
- `src/oauth.ts` — OAuth 2.0 + PKCE implementation
- `src/types.ts` — TypeScript types for vehicles, trips, and webhook events

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
