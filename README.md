# Bouncie MCP Server

An MCP (Model Context Protocol) server that exposes the [Bouncie](https://bouncie.com) vehicle tracking API. Connect your Bouncie OBD2 device data to any MCP-compatible AI assistant.

## Features

- **Vehicle info** — make, model, year, VIN, engine, nickname
- **Live vehicle stats** — GPS location, speed, fuel level, odometer, engine running status
- **Vehicle health** — battery status, check engine light (MIL), diagnostic trouble codes (DTCs)
- **Trip history** — distance, duration, speeds, fuel consumed, hard braking/acceleration, GPS traces
- **User profile** — authenticated user information

## Prerequisites

1. A [Bouncie](https://bouncie.com) account with at least one connected device
2. A Bouncie developer app — register at [bouncie.dev](https://www.bouncie.dev)
3. Node.js 18+

## Setup

### 1. Install

```bash
npm install
npm run build
```

### 2. Get Bouncie API credentials

1. Go to [bouncie.dev](https://www.bouncie.dev) and create an app
2. Note your **Client ID** and **Client Secret**
3. Set a **Redirect URI** (e.g. `https://example.com/callback`)
4. Under "Users & Devices", authorize your Bouncie account
5. Copy the **Authorization Code** from the device's expanded view

### 3. Configure environment

Set these environment variables:

| Variable | Required | Description |
|---|---|---|
| `BOUNCIE_CLIENT_ID` | Yes | Your app's client ID |
| `BOUNCIE_CLIENT_SECRET` | Yes | Your app's client secret |
| `BOUNCIE_REDIRECT_URI` | Yes | Redirect URI used during app registration |
| `BOUNCIE_AUTH_CODE` | One of these | Authorization code (exchanged for token automatically) |
| `BOUNCIE_ACCESS_TOKEN` | One of these | Pre-obtained access token (skip OAuth exchange) |

### 4. Add to your MCP client

#### Claude Desktop / Claude Code

Add to your MCP settings (`claude_desktop_config.json` or `.claude/settings.json`):

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

## Tools

### `get_vehicles`

List all vehicles on the account.

| Parameter | Type | Description |
|---|---|---|
| `vin` | string (optional) | Filter by VIN |
| `imei` | string (optional) | Filter by device IMEI |

**Returns:** Array of vehicles with model info, VIN, IMEI, nickname, and live stats (location, speed, fuel, odometer, engine status, battery, MIL/DTCs).

### `get_vehicle`

Get a single vehicle by VIN or IMEI.

| Parameter | Type | Description |
|---|---|---|
| `vin` | string (optional) | Vehicle VIN |
| `imei` | string (optional) | Device IMEI |

At least one identifier is required.

### `get_trips`

Get trip history for a vehicle.

| Parameter | Type | Description |
|---|---|---|
| `imei` | string | Device IMEI (required) |
| `starts_after` | string (optional) | ISO date — trips starting after this time |
| `ends_before` | string (optional) | ISO date — trips ending before this time |
| `gps_format` | `"polyline"` \| `"geojson"` (optional) | GPS data format (default: polyline) |
| `transaction_id` | string (optional) | Fetch a specific trip |

> **Note:** The date window (`starts_after` to `ends_before`) must be no longer than 1 week. Defaults to the last 7 days if not specified.

**Returns:** Array of trips with distance, duration, average/max speed, fuel consumed, hard braking/acceleration counts, odometer readings, and GPS trace.

### `get_user`

Get the authenticated user's profile.

No parameters.

## Development

```bash
npm run dev        # Run with tsx (hot reload)
npm run build      # Compile TypeScript
npm test           # Run tests
npm run test:watch # Watch mode
npm run lint       # Type check
```

## API Reference

This server wraps the [Bouncie REST API v1](https://docs.bouncie.dev):

- **Base URL:** `https://api.bouncie.dev/v1`
- **Auth:** `https://auth.bouncie.com/oauth/token`
- **Endpoints:** `/vehicles`, `/trips`, `/user`

## Webhook Event Types

Bouncie also supports webhooks (not exposed via this MCP server, but documented here for reference):

| Event Type | Description |
|---|---|
| `connect` | Device plugged in |
| `disconnect` | Device unplugged |
| `battery` | Battery status change (normal/critical) |
| `mil` | Check engine light on/off with DTC codes |
| `tripStart` | Trip begins — includes odometer |
| `tripEnd` | Trip ends — includes odometer, fuel consumed |
| `tripMetrics` | Trip summary — distance, time, speeds, braking/acceleration |
| `tripData` | Real-time GPS breadcrumbs during trip |

## License

MIT
