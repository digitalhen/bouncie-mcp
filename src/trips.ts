// ---------------------------------------------------------------------------
// Trip range fetching and aggregation
//
// The upstream /trips endpoint caps each query at a one-week window and always
// returns GPS geometry, which makes any multi-month question expensive to ask
// directly. Everything here exists to page that endpoint safely and reduce the
// result to numbers before it reaches the client.
// ---------------------------------------------------------------------------

import type { BouncieClient } from "./api.js";
import { BouncieApiError } from "./api.js";
import type { Trip } from "./types.js";

export const MILES_TO_KM = 1.609344;

/** The API rejects a /trips request without a gpsFormat, so one is always sent. */
const REQUIRED_GPS_FORMAT = "polyline";

/** Upstream caps a query at one week; step less than that so windows overlap. */
const WINDOW_DAYS = 7;
const STEP_DAYS = 6;

/**
 * Delay between upstream calls. Bouncie rate-limits, and a long range fans out
 * into many windows — 13 months is ~63 — so requests are serialized rather than
 * burst. That makes a first, uncached year-long query take roughly
 * `windows * THROTTLE_MS`; lower this via TRIP_THROTTLE_MS if the client's
 * timeout is tighter than the rate limit demands.
 */
const THROTTLE_MS = Number(process.env.TRIP_THROTTLE_MS ?? 250);
const MAX_RETRIES = 3;

export type Period = "day" | "week" | "month" | "year";

export interface FetchOptions {
  includeGps?: boolean;
  /** Overridable for tests. */
  throttleMs?: number;
}

export interface FetchResult {
  trips: Trip[];
  /** Date ranges that could not be fetched. Empty on a complete result. */
  warnings: string[];
  upstreamRequests: number;
}

// ---------------------------------------------------------------------------
// Chunk cache
//
// Historical trip data is immutable: a week that has ended never changes. Chunks
// wholly in the past are cached indefinitely; a chunk overlapping now gets a
// short TTL. This is a per-process performance cache only — a miss costs a
// fetch, never correctness — so it does not violate the statelessness the
// multi-instance deployment requires (see CLAUDE.md).
// ---------------------------------------------------------------------------

interface CacheEntry {
  trips: Trip[];
  expiresAt: number; // Infinity for closed windows
}

const OPEN_WINDOW_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 2000;

const chunkCache = new Map<string, CacheEntry>();

/** Exposed for tests. */
export function clearTripCache() {
  chunkCache.clear();
}

export function tripCacheSize(): number {
  return chunkCache.size;
}

function cacheGet(key: string): Trip[] | null {
  const hit = chunkCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    chunkCache.delete(key);
    return null;
  }
  return hit.trips;
}

function cacheSet(key: string, trips: Trip[], windowEnd: Date) {
  if (chunkCache.size >= MAX_CACHE_ENTRIES) {
    // Cheap eviction: drop the oldest insertion.
    const oldest = chunkCache.keys().next().value;
    if (oldest !== undefined) chunkCache.delete(oldest);
  }
  const closed = windowEnd.getTime() < Date.now();
  chunkCache.set(key, {
    trips,
    expiresAt: closed ? Infinity : Date.now() + OPEN_WINDOW_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// Dates and local-time bucketing
// ---------------------------------------------------------------------------

/** Parse a `YYYY-MM-DD` or ISO datetime into a Date, or throw a clear error. */
export function parseDate(value: string, label: string): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const ms = Date.parse(dateOnly ? `${value.trim()}T00:00:00Z` : value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a valid date: ${value}. Use YYYY-MM-DD or an ISO datetime.`);
  }
  return new Date(ms);
}

/** End of the given day in UTC, so an inclusive `until` covers the whole date. */
export function endOfDay(value: string, label: string): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  if (!dateOnly) return parseDate(value, label);
  const ms = Date.parse(`${value.trim()}T23:59:59.999Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} is not a valid date: ${value}. Use YYYY-MM-DD or an ISO datetime.`);
  }
  return new Date(ms);
}

/** `"-0400"` -> -240. Unparseable or absent offsets are treated as UTC. */
export function offsetMinutes(timeZone: string | undefined): number {
  if (!timeZone) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(timeZone.trim());
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/**
 * Shift a UTC instant into the trip's own local time. The result is only ever
 * read with UTC getters — it represents local wall-clock, not a real instant.
 */
function localWallClock(iso: string, timeZone?: string): Date {
  return new Date(Date.parse(iso) + offsetMinutes(timeZone) * 60_000);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO-8601 week number of the given wall-clock date. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of the current week determines the ISO year.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

/**
 * Bucket key for a trip, in the trip's own local time. A 9pm Eastern trip on the
 * last day of a month belongs to that month, not the next.
 */
export function bucketKey(startTime: string, timeZone: string | undefined, period: Period): string {
  const d = localWallClock(startTime, timeZone);
  switch (period) {
    case "day":
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    case "week": {
      const { year, week } = isoWeek(d);
      return `${year}-W${pad(week)}`;
    }
    case "year":
      return String(d.getUTCFullYear());
    case "month":
    default:
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  }
}

/** Local wall-clock rendering of an instant, with its offset. */
export function localTimeString(iso: string, timeZone: string | undefined): string {
  const d = localWallClock(iso, timeZone);
  const stamp =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return timeZone ? `${stamp}${timeZone}` : `${stamp}Z`;
}

// ---------------------------------------------------------------------------
// Trip classification
// ---------------------------------------------------------------------------

/**
 * A trip still underway omits endTime and the summary metrics, and returns a
 * null endOdometer. Such records must never be folded into totals.
 */
export function isPartial(trip: Trip): boolean {
  return (
    !trip.endTime ||
    trip.distance === undefined ||
    trip.distance === null ||
    trip.endOdometer === undefined ||
    trip.endOdometer === null
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  return err instanceof BouncieApiError && (err.status === 429 || err.status >= 500);
}

// ---------------------------------------------------------------------------
// Range fetching
// ---------------------------------------------------------------------------

/** Split an inclusive range into overlapping windows within the upstream cap. */
export function chunkRange(since: Date, until: Date): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  let cursor = since.getTime();
  const endMs = until.getTime();
  while (cursor <= endMs) {
    const windowEnd = Math.min(cursor + WINDOW_DAYS * 86_400_000, endMs);
    chunks.push({ start: new Date(cursor), end: new Date(windowEnd) });
    if (windowEnd >= endMs) break;
    cursor += STEP_DAYS * 86_400_000;
  }
  return chunks;
}

/**
 * Fetch every trip in a range, paging the one-week upstream limit.
 *
 * Windows overlap by a day so a trip spanning a boundary is not lost; duplicates
 * are removed by transactionId. Requests are serialized with a small delay, and
 * rate limits are retried with exponential backoff. A window that still fails is
 * reported in `warnings` rather than silently reducing the result — an
 * undercount reads as a real decline in driving, which is worse than a gap.
 */
export async function fetchTripsRange(
  client: BouncieClient,
  imei: string,
  since: Date,
  until: Date,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const includeGps = options.includeGps ?? false;
  const throttleMs = options.throttleMs ?? THROTTLE_MS;

  const byId = new Map<string, Trip>();
  const warnings: string[] = [];
  let upstreamRequests = 0;
  let first = true;

  for (const chunk of chunkRange(since, until)) {
    const cacheKey = `${imei}:${chunk.start.toISOString()}:${chunk.end.toISOString()}`;
    // GPS is only cached out, never in, so the cache serves the common path only.
    const cached = includeGps ? null : cacheGet(cacheKey);

    let trips: Trip[] | null = cached;

    if (!trips) {
      if (!first && throttleMs > 0) await sleep(throttleMs);
      first = false;

      let attempt = 0;
      for (;;) {
        try {
          upstreamRequests++;
          trips = await client.getTrips({
            imei,
            startsAfter: chunk.start.toISOString(),
            endsBefore: chunk.end.toISOString(),
            gpsFormat: REQUIRED_GPS_FORMAT,
          });
          break;
        } catch (err) {
          if (isRetryable(err) && attempt < MAX_RETRIES) {
            // Exponential backoff with jitter, so parallel callers desynchronize.
            const delay = 2 ** attempt * 1000 + Math.floor(Math.random() * 250);
            attempt++;
            await sleep(delay);
            continue;
          }
          warnings.push(
            `Failed to fetch ${chunk.start.toISOString().slice(0, 10)}..` +
              `${chunk.end.toISOString().slice(0, 10)}: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
          trips = null;
          break;
        }
      }

      if (trips && !includeGps) {
        trips = trips.map(stripGps);
        cacheSet(cacheKey, trips, chunk.end);
      }
    }

    for (const trip of trips ?? []) {
      // Overlapping windows return the same trip more than once.
      if (trip?.transactionId) byId.set(trip.transactionId, trip);
    }
  }

  const trips = [...byId.values()].sort(
    (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
  );

  return { trips, warnings, upstreamRequests };
}

/** Drop route geometry, which dominates the payload and is rarely wanted. */
export function stripGps(trip: Trip): Trip {
  const { gps, ...rest } = trip as Trip & { gps?: unknown };
  return rest as Trip;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Bucket {
  period: string;
  trip_count: number;
  idle_events: number;
  distance_mi: number;
  distance_km: number;
  fuel_consumed_gal: number;
  duration_min: number;
  driving_time_min: number;
  idle_time_min: number;
  avg_speed_mph: number;
  avg_speed_kmh: number;
  hard_braking: number;
  hard_acceleration: number;
}

interface Accumulator {
  trip_count: number;
  idle_events: number;
  distance_mi: number;
  fuel_consumed_gal: number;
  duration_min: number;
  idle_time_min: number;
  hard_braking: number;
  hard_acceleration: number;
}

function emptyAccumulator(): Accumulator {
  return {
    trip_count: 0,
    idle_events: 0,
    distance_mi: 0,
    fuel_consumed_gal: 0,
    duration_min: 0,
    idle_time_min: 0,
    hard_braking: 0,
    hard_acceleration: 0,
  };
}

function accumulate(acc: Accumulator, trip: Trip) {
  const distance = trip.distance ?? 0;
  // A zero-distance record is a real idle event with real fuel burn, not noise.
  // Counting it as a trip inflates trip_count; dropping it loses the fuel.
  if (distance > 0) acc.trip_count++;
  else acc.idle_events++;

  acc.distance_mi += distance;
  acc.fuel_consumed_gal += trip.fuelConsumed ?? 0;
  acc.idle_time_min += (trip.totalIdleDuration ?? 0) / 60;
  acc.hard_braking += trip.hardBrakingCount ?? 0;
  acc.hard_acceleration += trip.hardAccelerationCount ?? 0;

  if (trip.startTime && trip.endTime) {
    const ms = Date.parse(trip.endTime) - Date.parse(trip.startTime);
    if (Number.isFinite(ms) && ms > 0) acc.duration_min += ms / 60_000;
  }
}

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

function finalize(period: string, acc: Accumulator): Bucket {
  // Idle time is time inside trips with the vehicle stopped; moving time is the
  // remainder, and is the honest denominator for an average speed.
  const driving = Math.max(acc.duration_min - acc.idle_time_min, 0);
  const mph = driving > 0 ? acc.distance_mi / (driving / 60) : 0;
  return {
    period,
    trip_count: acc.trip_count,
    idle_events: acc.idle_events,
    distance_mi: round(acc.distance_mi, 2),
    distance_km: round(acc.distance_mi * MILES_TO_KM, 2),
    fuel_consumed_gal: round(acc.fuel_consumed_gal, 3),
    duration_min: round(acc.duration_min, 1),
    driving_time_min: round(driving, 1),
    idle_time_min: round(acc.idle_time_min, 1),
    avg_speed_mph: round(mph, 1),
    avg_speed_kmh: round(mph * MILES_TO_KM, 1),
    hard_braking: acc.hard_braking,
    hard_acceleration: acc.hard_acceleration,
  };
}

export interface MileageSummary {
  imei: string;
  since: string;
  until: string;
  period: Period;
  buckets: Bucket[];
  totals: Omit<Bucket, "period">;
  partial_trips: number;
  warnings?: string[];
  note: string;
}

/** Bucket completed trips by local date and total them. Empty buckets are omitted. */
export function summarize(
  trips: Trip[],
  period: Period,
  meta: { imei: string; since: string; until: string; warnings: string[] },
): MileageSummary {
  const buckets = new Map<string, Accumulator>();
  const overall = emptyAccumulator();
  let partial = 0;

  for (const trip of trips) {
    if (isPartial(trip)) {
      partial++;
      continue;
    }
    const key = bucketKey(trip.startTime, trip.timeZone, period);
    let acc = buckets.get(key);
    if (!acc) {
      acc = emptyAccumulator();
      buckets.set(key, acc);
    }
    accumulate(acc, trip);
    accumulate(overall, trip);
  }

  const ordered = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  const { period: _drop, ...totals } = finalize("totals", overall);

  return {
    imei: meta.imei,
    since: meta.since,
    until: meta.until,
    period,
    buckets: ordered.map(([key, acc]) => finalize(key, acc)),
    totals,
    partial_trips: partial,
    ...(meta.warnings.length ? { warnings: meta.warnings } : {}),
    note:
      "Distances summed from each trip's own distance field, never from odometer " +
      "differences (startOdometer is rounded). Buckets use each trip's local time " +
      "zone. trip_count counts moving trips; zero-distance idle events are counted " +
      "separately in idle_events but their fuel and idle time are included. " +
      "avg_speed is distance over moving time, excluding idle.",
  };
}
