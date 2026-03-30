import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BouncieClient, BouncieApiError } from "./api.js";
import type { GpsFormat } from "./types.js";

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createClient(): BouncieClient {
  return new BouncieClient({
    clientId: getEnvOrThrow("BOUNCIE_CLIENT_ID"),
    clientSecret: getEnvOrThrow("BOUNCIE_CLIENT_SECRET"),
    redirectUri: getEnvOrThrow("BOUNCIE_REDIRECT_URI"),
    authorizationCode: process.env.BOUNCIE_AUTH_CODE,
    accessToken: process.env.BOUNCIE_ACCESS_TOKEN,
  });
}

function formatError(error: unknown): string {
  if (error instanceof BouncieApiError) {
    return `Bouncie API error (${error.status}): ${error.message}${error.body ? `\n${error.body}` : ""}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "bouncie",
    version: "1.0.0",
  });

  server.tool(
    "get_vehicles",
    "List all vehicles on the Bouncie account. Returns vehicle info including make/model/year, VIN, IMEI, nickname, and live stats (location, speed, fuel level, odometer, engine status, battery, check engine light / DTCs). All timestamps are UTC. Use the stats.localTimeZone field (e.g. '-0500' = UTC-5 / Eastern) to convert to the vehicle's local time when presenting to the user.",
    {
      vin: z.string().optional().describe("Filter by VIN"),
      imei: z.string().optional().describe("Filter by device IMEI"),
    },
    async ({ vin, imei }) => {
      try {
        const client = createClient();
        const vehicles = await client.getVehicles({ vin, imei });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(vehicles, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get_vehicle",
    "Get details for a single vehicle by VIN or IMEI. Returns make/model/year, engine, nickname, and live stats (location, speed, fuel level, odometer, running status, battery, MIL/DTCs). All timestamps are UTC. Use stats.localTimeZone (e.g. '-0500') to convert to local time.",
    {
      vin: z.string().optional().describe("Vehicle VIN"),
      imei: z.string().optional().describe("Device IMEI"),
    },
    async ({ vin, imei }) => {
      if (!vin && !imei) {
        return {
          content: [{ type: "text" as const, text: "Provide either vin or imei to identify the vehicle." }],
          isError: true,
        };
      }
      try {
        const client = createClient();
        const vehicles = await client.getVehicles({ vin, imei });
        if (vehicles.length === 0) {
          return { content: [{ type: "text" as const, text: "No vehicle found matching the given criteria." }] };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(vehicles[0], null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get_trips",
    "Get trips for a vehicle. Requires IMEI. Optional date range (max 1 week window; defaults to last 7 days). Returns trip details including distance, duration, speeds, fuel consumed, hard braking/acceleration counts, and GPS data. All timestamps are UTC. Use the timeZone field (e.g. '-0500') to convert to local time.",
    {
      imei: z.string().describe("Device IMEI (required)"),
      starts_after: z.string().optional().describe("ISO date — only trips starting after this time (e.g. 2024-01-15)"),
      ends_before: z.string().optional().describe("ISO date — only trips ending before this time (e.g. 2024-01-22)"),
      gps_format: z.enum(["polyline", "geojson"]).optional().describe("GPS data format: polyline (default) or geojson"),
      transaction_id: z.string().optional().describe("Fetch a specific trip by its transaction ID"),
    },
    async ({ imei, starts_after, ends_before, gps_format, transaction_id }) => {
      try {
        const client = createClient();
        const trips = await client.getTrips({
          imei,
          startsAfter: starts_after,
          endsBefore: ends_before,
          gpsFormat: gps_format as GpsFormat | undefined,
          transactionId: transaction_id,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(trips, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get_user",
    "Get the authenticated Bouncie user's profile information.",
    {},
    async () => {
      try {
        const client = createClient();
        const user = await client.getUser();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(user, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  return server;
}
