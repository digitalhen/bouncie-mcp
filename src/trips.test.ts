import { describe, it, expect, beforeEach, vi } from "vitest";
import { BouncieClient, BouncieApiError } from "./api.js";
import type { Trip } from "./types.js";
import {
  bucketKey,
  chunkRange,
  clearTripCache,
  fetchTripsRange,
  isPartial,
  localTimeString,
  offsetMinutes,
  parseDate,
  endOfDay,
  stripGps,
  summarize,
  tripCacheSize,
  decodePolyline,
  tripPoints,
  matchesBbox,
  validateBbox,
  countUnlocatable,
  type BoundingBox,
} from "./trips.js";

function trip(overrides: Partial<Trip> & { transactionId: string; startTime: string }): Trip {
  return {
    hardBrakingCount: 0,
    hardAccelerationCount: 0,
    distance: 10,
    startOdometer: 1000,
    endOdometer: 1010,
    fuelConsumed: 0.5,
    totalIdleDuration: 0,
    timeZone: "-0400",
    gps: "encodedpolyline",
    endTime: overrides.startTime,
    ...overrides,
  } as Trip;
}

function client(): BouncieClient {
  return new BouncieClient({ accessToken: "t" });
}

beforeEach(() => {
  clearTripCache();
  vi.restoreAllMocks();
});

describe("date handling", () => {
  it("parses date-only and ISO inputs", () => {
    expect(parseDate("2026-03-01", "since").toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(endOfDay("2026-03-01", "until").toISOString()).toBe("2026-03-01T23:59:59.999Z");
  });

  it("rejects garbage with a clear message", () => {
    expect(() => parseDate("last tuesday", "since")).toThrow(/not a valid date/);
  });

  it("parses UTC offsets", () => {
    expect(offsetMinutes("-0400")).toBe(-240);
    expect(offsetMinutes("+0530")).toBe(330);
    expect(offsetMinutes(undefined)).toBe(0);
    expect(offsetMinutes("garbage")).toBe(0);
  });
});

describe("local-time bucketing", () => {
  // Acceptance check 3.
  it("keeps a 9pm local trip on the last day of the month in that month", () => {
    // 2026-08-01T01:30Z is 2026-07-31 21:30 in -0400.
    expect(bucketKey("2026-08-01T01:30:00Z", "-0400", "month")).toBe("2026-07");
    expect(bucketKey("2026-08-01T01:30:00Z", "-0400", "day")).toBe("2026-07-31");
    expect(bucketKey("2026-08-01T01:30:00Z", "-0400", "year")).toBe("2026");
  });

  it("buckets by UTC when no offset is given", () => {
    expect(bucketKey("2026-08-01T01:30:00Z", undefined, "month")).toBe("2026-08");
  });

  it("produces ISO week keys", () => {
    expect(bucketKey("2026-01-05T12:00:00Z", "+0000", "week")).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("renders local time with the trip's offset", () => {
    expect(localTimeString("2026-08-01T01:30:00Z", "-0400")).toBe("2026-07-31T21:30:00-0400");
  });
});

describe("chunking", () => {
  it("splits a long range into overlapping sub-week windows", () => {
    const chunks = chunkRange(new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    expect(chunks.length).toBeGreaterThan(4);
    for (const c of chunks) {
      const days = (c.end.getTime() - c.start.getTime()) / 86_400_000;
      expect(days).toBeLessThanOrEqual(7);
    }
    // Windows overlap so a trip on a boundary is not lost.
    expect(chunks[1].start.getTime()).toBeLessThan(chunks[0].end.getTime());
    expect(chunks[chunks.length - 1].end.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("handles a range inside a single window", () => {
    const chunks = chunkRange(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
    expect(chunks).toHaveLength(1);
  });
});

describe("partial trips", () => {
  it("recognises an in-progress trip", () => {
    const inProgress = {
      transactionId: "x-1-202608",
      startTime: "2026-08-01T10:00:00Z",
      startOdometer: 100,
      endOdometer: null,
      hardBrakingCount: 0,
      hardAccelerationCount: 0,
      timeZone: "-0400",
    } as Trip;
    expect(isPartial(inProgress)).toBe(true);
    expect(isPartial(trip({ transactionId: "a", startTime: "2026-08-01T10:00:00Z" }))).toBe(false);
  });
});

describe("summarize", () => {
  const meta = { imei: "862", since: "2026-07-01", until: "2026-08-31", warnings: [] };

  it("separates idle events from moving trips but keeps their fuel", () => {
    const summary = summarize(
      [
        trip({
          transactionId: "a",
          startTime: "2026-07-05T14:00:00Z",
          endTime: "2026-07-05T15:00:00Z",
          distance: 30,
          fuelConsumed: 1,
        }),
        // Zero-distance idle event: real fuel burn, not noise.
        trip({
          transactionId: "b",
          startTime: "2026-07-06T14:00:00Z",
          endTime: "2026-07-06T14:48:36Z",
          distance: 0,
          fuelConsumed: 0.33,
          totalIdleDuration: 2916,
        }),
      ],
      "month",
      meta,
    );
    const july = summary.buckets.find((b) => b.period === "2026-07")!;
    expect(july.trip_count).toBe(1);
    expect(july.idle_events).toBe(1);
    expect(july.fuel_consumed_gal).toBeCloseTo(1.33, 3);
    expect(july.distance_mi).toBe(30);
  });

  // Acceptance check 6.
  it("reports in-progress trips separately and excludes them from totals", () => {
    const summary = summarize(
      [
        trip({
          transactionId: "a",
          startTime: "2026-07-05T14:00:00Z",
          endTime: "2026-07-05T15:00:00Z",
          distance: 25,
        }),
        {
          transactionId: "live",
          startTime: "2026-07-09T14:00:00Z",
          startOdometer: 500,
          endOdometer: null,
          hardBrakingCount: 0,
          hardAccelerationCount: 0,
          timeZone: "-0400",
        } as Trip,
      ],
      "month",
      meta,
    );
    expect(summary.partial_trips).toBe(1);
    expect(summary.totals.distance_mi).toBe(25);
    expect(summary.totals.trip_count).toBe(1);
  });

  it("emits km alongside miles and omits empty buckets", () => {
    const summary = summarize(
      [trip({ transactionId: "a", startTime: "2026-07-05T14:00:00Z", endTime: "2026-07-05T15:00:00Z", distance: 100 })],
      "month",
      meta,
    );
    expect(summary.buckets).toHaveLength(1);
    expect(summary.buckets[0].distance_km).toBeCloseTo(160.93, 1);
    expect(summary.totals.distance_km).toBeCloseTo(160.93, 1);
  });

  it("computes average speed over moving time, excluding idle", () => {
    const summary = summarize(
      [
        trip({
          transactionId: "a",
          startTime: "2026-07-05T14:00:00Z",
          endTime: "2026-07-05T16:00:00Z", // 120 min total
          distance: 60,
          totalIdleDuration: 3600, // 60 min idle -> 60 min moving
        }),
      ],
      "month",
      meta,
    );
    const b = summary.buckets[0];
    expect(b.duration_min).toBeCloseTo(120, 1);
    expect(b.idle_time_min).toBeCloseTo(60, 1);
    expect(b.driving_time_min).toBeCloseTo(60, 1);
    expect(b.avg_speed_mph).toBeCloseTo(60, 1);
  });

  it("orders buckets chronologically", () => {
    const summary = summarize(
      [
        trip({ transactionId: "b", startTime: "2026-08-05T14:00:00Z", endTime: "2026-08-05T15:00:00Z" }),
        trip({ transactionId: "a", startTime: "2026-07-05T14:00:00Z", endTime: "2026-07-05T15:00:00Z" }),
      ],
      "month",
      meta,
    );
    expect(summary.buckets.map((b) => b.period)).toEqual(["2026-07", "2026-08"]);
  });

  it("surfaces warnings when a window failed", () => {
    const summary = summarize([], "month", { ...meta, warnings: ["Failed to fetch 2026-07-01..2026-07-08"] });
    expect(summary.warnings).toHaveLength(1);
  });
});

describe("fetchTripsRange", () => {
  it("dedupes trips returned by overlapping windows", async () => {
    const spy = vi
      .spyOn(BouncieClient.prototype, "getTrips")
      .mockResolvedValue([trip({ transactionId: "dupe", startTime: "2026-01-02T10:00:00Z" })]);

    const res = await fetchTripsRange(
      client(),
      "862",
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-20T00:00:00Z"),
      { throttleMs: 0 },
    );
    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(res.trips).toHaveLength(1);
  });

  // Acceptance checks 1 and 4.
  it("strips gps by default and keeps it when asked", async () => {
    vi.spyOn(BouncieClient.prototype, "getTrips").mockResolvedValue([
      trip({ transactionId: "a", startTime: "2026-01-02T10:00:00Z" }),
    ]);

    const without = await fetchTripsRange(client(), "862", new Date("2026-01-01Z"), new Date("2026-01-03Z"), {
      throttleMs: 0,
    });
    expect(JSON.stringify(without.trips)).not.toContain("gps");

    const with_ = await fetchTripsRange(client(), "862", new Date("2026-01-01Z"), new Date("2026-01-03Z"), {
      throttleMs: 0,
      includeGps: true,
    });
    expect(with_.trips[0].gps).toBe("encodedpolyline");
  });

  it("always sends a gpsFormat, which upstream requires", async () => {
    const spy = vi.spyOn(BouncieClient.prototype, "getTrips").mockResolvedValue([]);
    await fetchTripsRange(client(), "862", new Date("2026-01-01Z"), new Date("2026-01-03Z"), { throttleMs: 0 });
    expect(spy.mock.calls[0][0].gpsFormat).toBe("polyline");
  });

  // Acceptance check 5.
  it("serves a repeated historical range from cache with no upstream calls", async () => {
    const spy = vi
      .spyOn(BouncieClient.prototype, "getTrips")
      .mockResolvedValue([trip({ transactionId: "a", startTime: "2020-01-02T10:00:00Z" })]);

    const since = new Date("2020-01-01T00:00:00Z");
    const until = new Date("2020-01-20T00:00:00Z");
    const first = await fetchTripsRange(client(), "862", since, until, { throttleMs: 0 });
    expect(first.upstreamRequests).toBeGreaterThan(0);
    expect(tripCacheSize()).toBeGreaterThan(0);

    spy.mockClear();
    const second = await fetchTripsRange(client(), "862", since, until, { throttleMs: 0 });
    expect(second.upstreamRequests).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(second.trips).toHaveLength(1);
  });

  it("retries a rate limit and then succeeds", async () => {
    const spy = vi
      .spyOn(BouncieClient.prototype, "getTrips")
      .mockRejectedValueOnce(new BouncieApiError("rate limited", 429))
      .mockResolvedValue([trip({ transactionId: "a", startTime: "2026-01-02T10:00:00Z" })]);

    const res = await fetchTripsRange(client(), "862", new Date("2026-01-01Z"), new Date("2026-01-03Z"), {
      throttleMs: 0,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.trips).toHaveLength(1);
    expect(res.warnings).toHaveLength(0);
  }, 15000);

  it("reports a failed window instead of silently undercounting", async () => {
    vi.spyOn(BouncieClient.prototype, "getTrips").mockRejectedValue(
      new BouncieApiError("boom", 400),
    );
    const res = await fetchTripsRange(client(), "862", new Date("2026-01-01Z"), new Date("2026-01-03Z"), {
      throttleMs: 0,
    });
    expect(res.trips).toHaveLength(0);
    expect(res.warnings[0]).toMatch(/Failed to fetch 2026-01-01/);
  });

  it("sorts results by start time", async () => {
    vi.spyOn(BouncieClient.prototype, "getTrips").mockResolvedValue([
      trip({ transactionId: "b", startTime: "2026-01-03T10:00:00Z" }),
      trip({ transactionId: "a", startTime: "2026-01-02T10:00:00Z" }),
    ]);
    const res = await fetchTripsRange(client(), "862", new Date("2026-01-01Z"), new Date("2026-01-05Z"), {
      throttleMs: 0,
    });
    expect(res.trips.map((t) => t.transactionId)).toEqual(["a", "b"]);
  });
});

describe("odometer cross-check (acceptance check 2)", () => {
  /**
   * startOdometer is rounded to whole miles while endOdometer is not, so
   * consecutive trips disagree at the seam. Summed distance must track the
   * endOdometer delta; differencing across trips must not be relied on.
   */
  const consecutive = [
    trip({
      transactionId: "t1",
      startTime: "2026-07-01T14:00:00Z",
      endTime: "2026-07-01T15:00:00Z",
      distance: 25.5,
      startOdometer: 28012,
      endOdometer: 28037.5,
    }),
    // Next trip starts at a rounded 28038, not the true 28037.5.
    trip({
      transactionId: "t2",
      startTime: "2026-07-02T14:00:00Z",
      endTime: "2026-07-02T15:00:00Z",
      distance: 24.7,
      startOdometer: 28038,
      endOdometer: 28062.2,
    }),
    trip({
      transactionId: "t3",
      startTime: "2026-07-03T14:00:00Z",
      endTime: "2026-07-03T15:00:00Z",
      distance: 30.3,
      startOdometer: 28062,
      endOdometer: 28092.5,
    }),
  ];

  it("summed distance matches the odometer span within 1%", () => {
    const summary = summarize(consecutive, "month", {
      imei: "862",
      since: "2026-07-01",
      until: "2026-07-31",
      warnings: [],
    });
    const span = 28092.5 - 28012; // last endOdometer minus first startOdometer
    const summed = summary.totals.distance_mi;
    expect(Math.abs(summed - span) / span).toBeLessThan(0.01);
  });

  it("differencing odometers across trips drifts, which is why distance is summed", () => {
    // Sum of per-trip (end - start) disagrees with the true summed distance,
    // because each start is rounded. This documents the trap.
    const differenced = consecutive.reduce(
      (a, t) => a + ((t.endOdometer as number) - t.startOdometer),
      0,
    );
    const summed = consecutive.reduce((a, t) => a + (t.distance ?? 0), 0);
    expect(differenced).not.toBeCloseTo(summed, 5);
  });
});

describe("stripGps", () => {
  it("removes only the gps field", () => {
    const t = trip({ transactionId: "a", startTime: "2026-01-02T10:00:00Z" });
    const s = stripGps(t);
    expect("gps" in s).toBe(false);
    expect(s.distance).toBe(t.distance);
  });
});

describe("geographic filtering", () => {
  // Google-encoded polyline for a short route near Austin, TX.
  // Encoded from [[30.2672,-97.7431],[30.2700,-97.7400],[30.2750,-97.7350]].
  const austinRoute = encodePolylineForTest([
    [30.2672, -97.7431],
    [30.27, -97.74],
    [30.275, -97.735],
  ]);

  const AUSTIN: BoundingBox = { min_lat: 30.2, min_lon: -97.8, max_lat: 30.3, max_lon: -97.7 };
  const DALLAS: BoundingBox = { min_lat: 32.6, min_lon: -96.9, max_lat: 32.9, max_lon: -96.6 };

  it("round-trips an encoded polyline", () => {
    const points = decodePolyline(austinRoute);
    expect(points).toHaveLength(3);
    expect(points[0][0]).toBeCloseTo(30.2672, 4);
    expect(points[0][1]).toBeCloseTo(-97.7431, 4);
    expect(points[2][0]).toBeCloseTo(30.275, 4);
  });

  it("returns nothing for malformed polylines rather than throwing", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(() => decodePolyline("!!!not-a-polyline!!!")).not.toThrow();
  });

  it("reads GeoJSON coordinates as [lon, lat] per RFC 7946", () => {
    const t = trip({
      transactionId: "g",
      startTime: "2026-07-01T10:00:00Z",
      gps: { type: "LineString", coordinates: [[-97.7431, 30.2672]] },
    });
    expect(tripPoints(t)[0][0]).toBeCloseTo(30.2672, 4);
    expect(tripPoints(t)[0][1]).toBeCloseTo(-97.7431, 4);
  });

  describe("match modes", () => {
    const t = trip({ transactionId: "a", startTime: "2026-07-01T10:00:00Z", gps: austinRoute });

    it("intersects matches a route passing through the box", () => {
      expect(matchesBbox(t, AUSTIN, "intersects")).toBe(true);
      expect(matchesBbox(t, DALLAS, "intersects")).toBe(false);
    });

    it("start and end test only the respective endpoint", () => {
      const startOnly: BoundingBox = {
        min_lat: 30.266, min_lon: -97.744, max_lat: 30.268, max_lon: -97.742,
      };
      expect(matchesBbox(t, startOnly, "start")).toBe(true);
      expect(matchesBbox(t, startOnly, "end")).toBe(false);
    });

    it("contains requires the whole route to stay inside", () => {
      expect(matchesBbox(t, AUSTIN, "contains")).toBe(true);
      const clipped: BoundingBox = {
        min_lat: 30.266, min_lon: -97.744, max_lat: 30.271, max_lon: -97.739,
      };
      expect(matchesBbox(t, clipped, "intersects")).toBe(true);
      expect(matchesBbox(t, clipped, "contains")).toBe(false);
    });

    it("never matches a trip with no decodable route", () => {
      const noGps = trip({ transactionId: "n", startTime: "2026-07-01T10:00:00Z", gps: undefined });
      expect(matchesBbox(noGps, AUSTIN, "intersects")).toBe(false);
      expect(countUnlocatable([noGps])).toBe(1);
    });
  });

  describe("validateBbox", () => {
    it("accepts a well-formed box", () => {
      expect(() => validateBbox(AUSTIN)).not.toThrow();
    });
    it("rejects inverted edges", () => {
      expect(() => validateBbox({ ...AUSTIN, min_lat: 40 })).toThrow(/min_lat must be <=/);
      expect(() => validateBbox({ ...AUSTIN, min_lon: 0 })).toThrow(/antimeridian/);
    });
    it("rejects out-of-range coordinates", () => {
      expect(() => validateBbox({ ...AUSTIN, max_lat: 91 })).toThrow(/between -90 and 90/);
      expect(() => validateBbox({ ...AUSTIN, min_lon: -181 })).toThrow(/between -180 and 180/);
    });
  });

  describe("fetchTripsRange with a bbox", () => {
    beforeEach(() => {
      vi.spyOn(BouncieClient.prototype, "getTrips").mockResolvedValue([
        trip({ transactionId: "in", startTime: "2026-07-01T10:00:00Z", gps: austinRoute }),
        trip({
          transactionId: "out",
          startTime: "2026-07-02T10:00:00Z",
          gps: encodePolylineForTest([[32.7767, -96.797]]),
        }),
      ]);
    });

    it("keeps only matching trips and reports what it removed", async () => {
      const res = await fetchTripsRange(
        client(), "862", new Date("2026-07-01Z"), new Date("2026-07-03Z"),
        { bbox: AUSTIN, throttleMs: 0 },
      );
      expect(res.trips.map((t) => t.transactionId)).toEqual(["in"]);
      expect(res.filtered_out).toBe(1);
      expect(res.unlocatable).toBe(0);
    });

    it("strips the geometry it had to fetch, unless GPS was also requested", async () => {
      const stripped = await fetchTripsRange(
        client(), "862", new Date("2026-07-01Z"), new Date("2026-07-03Z"),
        { bbox: AUSTIN, throttleMs: 0 },
      );
      expect("gps" in stripped.trips[0]).toBe(false);

      clearTripCache();
      const kept = await fetchTripsRange(
        client(), "862", new Date("2026-07-01Z"), new Date("2026-07-03Z"),
        { bbox: AUSTIN, includeGps: true, throttleMs: 0 },
      );
      expect(kept.trips[0].gps).toBeTruthy();
    });

    it("caches gps-bearing chunks separately from stripped ones", async () => {
      const range = [new Date("2020-07-01Z"), new Date("2020-07-03Z")] as const;
      await fetchTripsRange(client(), "862", range[0], range[1], { throttleMs: 0 });
      const afterPlain = tripCacheSize();
      await fetchTripsRange(client(), "862", range[0], range[1], { bbox: AUSTIN, throttleMs: 0 });
      // A separate entry, so the stripped cache is not poisoned with geometry.
      expect(tripCacheSize()).toBeGreaterThan(afterPlain);
    });
  });

  it("summarize reports bbox provenance", () => {
    const summary = summarize(
      [trip({ transactionId: "a", startTime: "2026-07-05T14:00:00Z", endTime: "2026-07-05T15:00:00Z" })],
      "month",
      {
        imei: "862", since: "2026-07-01", until: "2026-07-31", warnings: [],
        bbox: AUSTIN, bboxMatch: "intersects", excludedByBbox: 4, unlocatable: 1,
      },
    );
    expect(summary.bbox).toEqual(AUSTIN);
    expect(summary.bbox_match).toBe("intersects");
    expect(summary.excluded_by_bbox).toBe(4);
    expect(summary.unlocatable_trips).toBe(1);
    // The caveat that a matched trip counts in full must be stated in the payload.
    expect(summary.note).toMatch(/ENTIRE distance/);
  });
});

/** Minimal Google polyline encoder, so fixtures are readable as coordinates. */
function encodePolylineForTest(points: Array<[number, number]>): string {
  let lastLat = 0;
  let lastLon = 0;
  let out = "";
  const chunk = (v: number) => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (value >= 0x20) {
      s += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    s += String.fromCharCode(value + 63);
    return s;
  };
  for (const [lat, lon] of points) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += chunk(la - lastLat) + chunk(lo - lastLon);
    lastLat = la;
    lastLon = lo;
  }
  return out;
}
