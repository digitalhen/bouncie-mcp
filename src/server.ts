import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BouncieClient, BouncieApiError } from "./api.js";
import type { GpsFormat, Trip } from "./types.js";
import {
  fetchTripsRange,
  summarize,
  parseDate,
  endOfDay,
  isPartial,
  localTimeString,
  stripGps,
  type Period,
} from "./trips.js";

function formatError(error: unknown): string {
  if (error instanceof BouncieApiError) {
    return `Bouncie API error (${error.status}): ${error.message}${error.body ? `\n${error.body}` : ""}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export interface ServerOptions {
  /** Bouncie access token for this user's session */
  bouncieAccessToken?: string;
}

export function createServer(options?: ServerOptions): McpServer {
  const server = new McpServer({
    name: "bouncie",
    version: "1.0.0",
  });

  function createClient(): BouncieClient {
    const token = options?.bouncieAccessToken;
    if (!token) {
      throw new Error(
        "Not authenticated with Bouncie. Please complete the OAuth authorization flow first.",
      );
    }
    return new BouncieClient({
      clientId: "",
      clientSecret: "",
      redirectUri: "",
      accessToken: token,
    });
  }

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
    "Get individual trips for a vehicle. Requires IMEI. Optional date range (max 1 week window; defaults to last 7 days). Returns per-trip distance, duration, speeds, fuel consumed, and hard braking/acceleration counts. GPS route geometry is EXCLUDED by default because it dominates the payload — pass include_gps: true only when you actually need the route. For totals over more than a week (monthly series, before/after comparisons), use get_mileage_summary instead of paging this tool. All timestamps are UTC; use the timeZone field (e.g. '-0500') to convert to local time. A trip still in progress omits endTime, distance, and speeds.",
    {
      imei: z.string().describe("Device IMEI (required)"),
      starts_after: z.string().optional().describe("ISO date — only trips starting after this time (e.g. 2024-01-15)"),
      ends_before: z.string().optional().describe("ISO date — only trips ending before this time (e.g. 2024-01-22)"),
      include_gps: z
        .boolean()
        .optional()
        .describe("Include GPS route geometry. Defaults to false; it is typically ~90% of the payload."),
      gps_format: z
        .enum(["polyline", "geojson"])
        .optional()
        .describe("Format for GPS data when include_gps is true (default: polyline)"),
      transaction_id: z.string().optional().describe("Fetch a specific trip by its transaction ID"),
    },
    async ({ imei, starts_after, ends_before, include_gps, gps_format, transaction_id }) => {
      try {
        const client = createClient();
        const trips = await client.getTrips({
          imei,
          startsAfter: starts_after,
          endsBefore: ends_before,
          // Upstream rejects the request without a gpsFormat, so one is always
          // sent and the result is stripped here when it was not asked for.
          gpsFormat: (gps_format as GpsFormat | undefined) ?? "polyline",
          transactionId: transaction_id,
        });
        const payload = include_gps ? trips : trips.map(stripGps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get_mileage_summary",
    "Aggregate driving totals for a vehicle over any date range, bucketed by day, week, month, or year. Use this for trend questions — monthly mileage series, before/after comparisons, year-over-year — instead of paging get_trips, which is capped at one week per call. Returns no GPS data at all. Per bucket: trip_count (moving trips), idle_events (zero-distance records, which still burn fuel), distance in miles and km, fuel consumed, driving and idle time, average speed, and hard braking/acceleration counts. Trips are bucketed by the vehicle's LOCAL date, so a 9pm trip stays in that day. Distances are summed from each trip's exact distance field, never from odometer differences.",
    {
      imei: z.string().describe("Device IMEI (required)"),
      since: z.string().describe("Start of range, inclusive (YYYY-MM-DD)"),
      until: z.string().describe("End of range, inclusive (YYYY-MM-DD)"),
      period: z
        .enum(["day", "week", "month", "year"])
        .optional()
        .describe("Bucket size (default: month)"),
    },
    async ({ imei, since, until, period }) => {
      try {
        const client = createClient();
        const from = parseDate(since, "since");
        const to = endOfDay(until, "until");
        if (from > to) {
          return {
            content: [{ type: "text" as const, text: "`since` must be on or before `until`." }],
            isError: true,
          };
        }

        const { trips, warnings } = await fetchTripsRange(client, imei, from, to);
        const summary = summarize(trips, (period as Period) ?? "month", {
          imei,
          since,
          until,
          warnings,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: formatError(error) }], isError: true };
      }
    },
  );

  server.tool(
    "get_odometer_at",
    "Get the vehicle's odometer reading at or before a given moment, by finding the most recent completed trip. Searches backward up to 30 days and reports gap_hours — how far before the requested time the reading actually is — so you can judge whether it is close enough to be meaningful. Useful for computing distance between two dates as a cross-check on get_mileage_summary.",
    {
      imei: z.string().describe("Device IMEI (required)"),
      date: z.string().describe("Point in time (YYYY-MM-DD or ISO datetime)"),
    },
    async ({ imei, date }) => {
      try {
        const client = createClient();
        const target = endOfDay(date, "date");

        const MAX_LOOKBACK_DAYS = 30;
        const WEEK_MS = 7 * 86_400_000;
        let best: Trip | undefined;

        // Walk backward a week at a time and stop as soon as something is found,
        // rather than scanning the full history for a vehicle that has been idle.
        for (let week = 0; week < Math.ceil(MAX_LOOKBACK_DAYS / 7); week++) {
          const end = new Date(target.getTime() - week * WEEK_MS);
          const start = new Date(end.getTime() - WEEK_MS);
          const { trips } = await fetchTripsRange(client, imei, start, end);
          const usable = trips.filter(
            (t) => !isPartial(t) && t.endTime && Date.parse(t.endTime) <= target.getTime(),
          );
          if (usable.length > 0) {
            best = usable[usable.length - 1];
            break;
          }
        }

        if (!best || !best.endTime) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No completed trip found within ${MAX_LOOKBACK_DAYS} days before ${date}, so no odometer reading is available for that time.`,
              },
            ],
            isError: true,
          };
        }

        const readingMs = Date.parse(best.endTime);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  imei,
                  requested: date,
                  // endOdometer is unrounded, unlike startOdometer.
                  odometer_mi: best.endOdometer,
                  reading_time: best.endTime,
                  local_time: localTimeString(best.endTime, best.timeZone),
                  source_transaction_id: best.transactionId,
                  gap_hours: Math.round(((target.getTime() - readingMs) / 3_600_000) * 10) / 10,
                },
                null,
                2,
              ),
            },
          ],
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
