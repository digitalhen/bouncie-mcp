import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { clearTripCache } from "./trips.js";
import type { Trip } from "./types.js";

/**
 * These exercise the real tool definitions through the MCP transport, with only
 * the network mocked, so schema and response shape are covered as well as logic.
 */

const IMEI = "862255068899233";

function makeTrip(over: Partial<Trip> & { transactionId: string; startTime: string }): Trip {
  return {
    hardBrakingCount: 1,
    hardAccelerationCount: 2,
    distance: 12.5,
    startOdometer: 28062,
    endOdometer: 28074.5,
    averageSpeed: 30,
    maxSpeed: 62.137100000000004,
    fuelConsumed: 0.6,
    totalIdleDuration: 120,
    timeZone: "-0400",
    gps: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    endTime: over.startTime,
    ...over,
  } as Trip;
}

/** Responds to /trips with whatever the current scenario provides. */
let tripsFor: (url: string) => Trip[];
let tripCalls: string[];

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    if (u.includes("/v1/trips")) {
      tripCalls.push(u);
      return ok(tripsFor(u));
    }
    if (u.includes("/v1/vehicles")) return ok([]);
    return { ok: false, status: 404, statusText: "Not Found", text: async () => "nf", json: async () => ({}) };
  });
}

async function connect() {
  const server = createServer({ bouncieAccessToken: "test-token" });
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: any): string {
  return result.content[0].text as string;
}

describe("aggregation and payload-control tools", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearTripCache();
    tripCalls = [];
    tripsFor = () => [];
    globalThis.fetch = mockFetch() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("exposes the three new tools alongside the originals", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_mileage_summary",
      "get_odometer_at",
      "get_trips",
      "get_user",
      "get_vehicle",
      "get_vehicles",
    ]);
  });

  // Acceptance check 4.
  describe("get_trips include_gps", () => {
    beforeEach(() => {
      tripsFor = () => [makeTrip({ transactionId: `${IMEI}-1-202608`, startTime: "2026-08-10T14:00:00Z" })];
    });

    it("omits gps by default", async () => {
      const client = await connect();
      const res = await client.callTool({ name: "get_trips", arguments: { imei: IMEI } });
      const text = textOf(res);
      expect(text).not.toContain("gps");
      expect(text).toContain("distance");
    });

    it("returns gps when explicitly requested", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_trips",
        arguments: { imei: IMEI, include_gps: true },
      });
      expect(textOf(res)).toContain("aaaaaaaaaa");
    });

    it("sends a gpsFormat upstream even when the caller omits it", async () => {
      const client = await connect();
      await client.callTool({ name: "get_trips", arguments: { imei: IMEI } });
      expect(tripCalls[0]).toContain("gpsFormat=polyline");
    });
  });

  // Acceptance checks 1, 2, 3, 6.
  describe("get_mileage_summary", () => {
    it("returns a compact multi-month series containing no gps anywhere", async () => {
      tripsFor = (u) => {
        // One trip per window, dated inside it.
        const start = new URL(u).searchParams.get("startsAfter")!;
        const day = start.slice(0, 10);
        return [
          makeTrip({
            transactionId: `${IMEI}-${day}-x`,
            startTime: `${day}T14:00:00Z`,
            endTime: `${day}T15:00:00Z`,
            distance: 10,
          }),
        ];
      };

      const client = await connect();
      const res = await client.callTool({
        name: "get_mileage_summary",
        arguments: { imei: IMEI, since: "2025-08-01", until: "2026-08-31", period: "month" },
      });
      const text = textOf(res);
      expect(text).not.toContain("gps");
      expect(text).not.toContain("aaaaaaaaaa");

      const summary = JSON.parse(text);
      expect(summary.period).toBe("month");
      expect(summary.buckets.length).toBeGreaterThan(11);
      expect(summary.totals.distance_mi).toBeGreaterThan(0);
      // Every bucket carries both unit systems, for comparison with the bike series.
      for (const b of summary.buckets) {
        expect(b.distance_km).toBeCloseTo(b.distance_mi * 1.609344, 1);
        expect(b).toHaveProperty("avg_speed_mph");
        expect(b).toHaveProperty("avg_speed_kmh");
      }
    }, 60000);

    it("buckets a late-evening local trip into the month it started", async () => {
      tripsFor = () => [
        makeTrip({
          transactionId: `${IMEI}-1-202608`,
          // 01:30Z on Aug 1 is 21:30 on Jul 31 in -0400.
          startTime: "2026-08-01T01:30:00Z",
          endTime: "2026-08-01T02:00:00Z",
          distance: 20,
        }),
      ];
      const client = await connect();
      const res = await client.callTool({
        name: "get_mileage_summary",
        arguments: { imei: IMEI, since: "2026-07-25", until: "2026-08-05" },
      });
      const summary = JSON.parse(textOf(res));
      expect(summary.buckets.map((b: any) => b.period)).toContain("2026-07");
      expect(summary.buckets.find((b: any) => b.period === "2026-07").distance_mi).toBe(20);
    });

    it("counts an in-progress trip as partial without corrupting totals", async () => {
      tripsFor = () => [
        makeTrip({
          transactionId: `${IMEI}-1-202608`,
          startTime: "2026-08-10T14:00:00Z",
          endTime: "2026-08-10T15:00:00Z",
          distance: 30,
        }),
        {
          transactionId: `${IMEI}-2-202608`,
          startTime: "2026-08-11T14:00:00Z",
          startOdometer: 28100,
          endOdometer: null,
          hardBrakingCount: 0,
          hardAccelerationCount: 0,
          timeZone: "-0400",
        } as Trip,
      ];
      const client = await connect();
      const res = await client.callTool({
        name: "get_mileage_summary",
        arguments: { imei: IMEI, since: "2026-08-09", until: "2026-08-12" },
      });
      const summary = JSON.parse(textOf(res));
      expect(summary.partial_trips).toBe(1);
      expect(summary.totals.distance_mi).toBe(30);
      expect(summary.totals.trip_count).toBe(1);
    });

    it("rejects an inverted range clearly", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_mileage_summary",
        arguments: { imei: IMEI, since: "2026-08-10", until: "2026-08-01" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/on or before/);
    });

    // Acceptance check 5.
    it("issues zero upstream requests on an identical repeat query", async () => {
      tripsFor = () => [
        makeTrip({
          transactionId: `${IMEI}-1-202001`,
          startTime: "2020-01-05T14:00:00Z",
          endTime: "2020-01-05T15:00:00Z",
        }),
      ];
      const client = await connect();
      const args = { imei: IMEI, since: "2020-01-01", until: "2020-03-01" };

      const first = JSON.parse(textOf(await client.callTool({ name: "get_mileage_summary", arguments: args })));
      expect(tripCalls.length).toBeGreaterThan(0);

      tripCalls = [];
      const second = JSON.parse(textOf(await client.callTool({ name: "get_mileage_summary", arguments: args })));
      expect(tripCalls).toHaveLength(0);
      expect(second.totals).toEqual(first.totals);
    });
  });

  describe("geographic filtering", () => {
    // Decodes to [30.29322,-97.67036] -> [30.29434,-97.66287] -> [30.29610,-97.65538],
    // i.e. east Austin, TX — inside AUSTIN below.
    const AUSTIN_ROUTE = "ss{wDvfcsQ_Fym@_Jym@";
    const AUSTIN = { min_lat: 30.2, min_lon: -97.8, max_lat: 30.4, max_lon: -97.6 };

    beforeEach(() => {
      tripsFor = () => [
        makeTrip({
          transactionId: `${IMEI}-1-202607`,
          startTime: "2026-07-01T14:00:00Z",
          endTime: "2026-07-01T15:00:00Z",
          distance: 12,
          gps: AUSTIN_ROUTE,
        }),
        makeTrip({
          transactionId: `${IMEI}-2-202607`,
          startTime: "2026-07-02T14:00:00Z",
          endTime: "2026-07-02T15:00:00Z",
          distance: 40,
          // Decodes to [50.5304,-3.57048] — Devon, UK. Nowhere near the box.
          gps: "_flsHnjxTs@s@",
        }),
      ];
    });

    it("get_trips keeps only trips touching the box and still omits gps", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_trips",
        arguments: { imei: IMEI, bbox: AUSTIN },
      });
      const out = JSON.parse(textOf(res));
      expect(out.matched).toBe(1);
      expect(out.excluded_by_bbox).toBe(1);
      expect(out.trips[0].transactionId).toBe(`${IMEI}-1-202607`);
      expect("gps" in out.trips[0]).toBe(false);
    });

    it("get_trips can return the geometry it filtered on", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_trips",
        arguments: { imei: IMEI, bbox: AUSTIN, include_gps: true },
      });
      const out = JSON.parse(textOf(res));
      expect(out.trips[0].gps).toBe(AUSTIN_ROUTE);
    });

    it("get_mileage_summary totals only the matching trips", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_mileage_summary",
        arguments: { imei: IMEI, since: "2026-07-01", until: "2026-07-03", bbox: AUSTIN },
      });
      const summary = JSON.parse(textOf(res));
      expect(summary.totals.distance_mi).toBe(12);
      expect(summary.totals.trip_count).toBe(1);
      expect(summary.bbox).toEqual(AUSTIN);
      expect(summary.excluded_by_bbox).toBe(1);
      expect(summary.note).toMatch(/ENTIRE distance/);
      expect(textOf(res)).not.toContain("gps");
    });

    it("rejects an invalid box with a usable message", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_trips",
        arguments: { imei: IMEI, bbox: { ...AUSTIN, max_lat: 200 } },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/between -90 and 90/);
    });

    it("supports the start match mode", async () => {
      const client = await connect();
      const res = await client.callTool({
        name: "get_trips",
        arguments: { imei: IMEI, bbox: AUSTIN, bbox_match: "start" },
      });
      const out = JSON.parse(textOf(res));
      expect(out.bbox_match).toBe("start");
      expect(out.matched).toBe(1);
    });
  });

  describe("get_odometer_at", () => {
    it("returns the nearest completed reading before the requested time", async () => {
      tripsFor = () => [
        makeTrip({
          transactionId: `${IMEI}-1-202608`,
          startTime: "2026-08-10T14:00:00Z",
          endTime: "2026-08-10T15:00:00Z",
          endOdometer: 28074.5,
        }),
      ];
      const client = await connect();
      const res = await client.callTool({
        name: "get_odometer_at",
        arguments: { imei: IMEI, date: "2026-08-12" },
      });
      const out = JSON.parse(textOf(res));
      // endOdometer is unrounded and is what should be reported.
      expect(out.odometer_mi).toBe(28074.5);
      expect(out.source_transaction_id).toBe(`${IMEI}-1-202608`);
      expect(out.reading_time).toBe("2026-08-10T15:00:00Z");
      expect(out.local_time).toBe("2026-08-10T11:00:00-0400");
      expect(out.gap_hours).toBeGreaterThan(0);
    });

    it("reports clearly when nothing is within the lookback window", async () => {
      tripsFor = () => [];
      const client = await connect();
      const res = await client.callTool({
        name: "get_odometer_at",
        arguments: { imei: IMEI, date: "2026-08-12" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/No completed trip found within 30 days/);
    });

    it("ignores an in-progress trip with a null odometer", async () => {
      tripsFor = () => [
        {
          transactionId: `${IMEI}-9-202608`,
          startTime: "2026-08-11T14:00:00Z",
          startOdometer: 28100,
          endOdometer: null,
          hardBrakingCount: 0,
          hardAccelerationCount: 0,
          timeZone: "-0400",
        } as Trip,
      ];
      const client = await connect();
      const res = await client.callTool({
        name: "get_odometer_at",
        arguments: { imei: IMEI, date: "2026-08-12" },
      });
      expect(res.isError).toBe(true);
    });
  });
});
