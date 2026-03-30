import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BouncieClient, BouncieApiError } from "./api.js";
import type { Vehicle, Trip, User, TokenResponse } from "./types.js";

// --- Test fixtures ---

const MOCK_TOKEN_RESPONSE: TokenResponse = {
  access_token: "test-access-token-abc123",
  token_type: "Bearer",
  expires_in: 3600,
};

const MOCK_VEHICLE: Vehicle = {
  model: { make: "TOYOTA", name: "PRIUS", year: 2020 },
  standardEngine: "1.8L I4",
  vin: "JTDKN3DU5A0000001",
  imei: "353762078072777",
  nickName: "My Prius",
  stats: {
    localTimeZone: "-0500",
    lastUpdated: "2024-06-15T14:30:00.000Z",
    odometer: 45230,
    location: {
      lat: 32.915987,
      lon: -96.772574,
      heading: 180,
      address: "123 Main St, Dallas, TX 75201",
    },
    fuelLevel: 72.5,
    isRunning: false,
    speed: 0,
    mil: {
      milOn: false,
      lastUpdated: "2024-06-10T08:00:00.000Z",
      qualifiedDtcList: [],
    },
    battery: {
      status: "normal",
      lastUpdated: "2024-06-01T12:00:00.000Z",
    },
  },
};

const MOCK_TRIP: Trip = {
  transactionId: "353762078072777-1234-1718460000000",
  hardBrakingCount: 1,
  hardAccelerationCount: 2,
  distance: 12.5,
  gps: "encoded_polyline_string",
  startTime: "2024-06-15T08:00:00.000Z",
  endTime: "2024-06-15T08:25:00.000Z",
  startOdometer: 45218,
  endOdometer: 45230,
  averageSpeed: 30.0,
  maxSpeed: 55.0,
  fuelConsumed: 0.8,
  timeZone: "-0500",
};

const MOCK_USER: User = {
  email: "test@example.com",
  name: "Test User",
};

// --- Helpers ---

function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const response = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.ok ? "OK" : "Error",
      text: async () => JSON.stringify(response.body),
      json: async () => response.body,
    };
  });
}

function createClient(overrides?: { accessToken?: string; authorizationCode?: string }) {
  return new BouncieClient({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "https://example.com/callback",
    authorizationCode: overrides?.authorizationCode ?? "test-auth-code",
    accessToken: overrides?.accessToken,
  });
}

// --- Tests ---

describe("BouncieClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("authenticate", () => {
    it("exchanges authorization code for access token", async () => {
      const fetchMock = mockFetch([
        { ok: true, status: 200, body: MOCK_TOKEN_RESPONSE },
      ]);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createClient();
      const token = await client.authenticate();

      expect(token).toBe("test-access-token-abc123");
      expect(fetchMock).toHaveBeenCalledOnce();

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://auth.bouncie.com/oauth/token");
      expect(options.method).toBe("POST");

      const body = new URLSearchParams(options.body);
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("test-auth-code");
      expect(body.get("redirect_uri")).toBe("https://example.com/callback");
    });

    it("throws BouncieApiError on auth failure", async () => {
      globalThis.fetch = mockFetch([
        { ok: false, status: 401, body: { error: "invalid_grant" } },
      ]) as unknown as typeof fetch;

      const client = createClient();
      await expect(client.authenticate()).rejects.toThrow(BouncieApiError);
    });
  });

  describe("getVehicles", () => {
    it("fetches all vehicles with auth token", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [MOCK_VEHICLE] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "pre-set-token" });
      const vehicles = await client.getVehicles();

      expect(vehicles).toEqual([MOCK_VEHICLE]);
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/v1/vehicles");
      expect(options.headers.Authorization).toBe("pre-set-token");
    });

    it("authenticates first if no token", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: MOCK_TOKEN_RESPONSE },
        { ok: true, status: 200, body: [MOCK_VEHICLE] },
      ]) as unknown as typeof fetch;

      const client = createClient();
      const vehicles = await client.getVehicles();

      expect(vehicles).toEqual([MOCK_VEHICLE]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("filters by IMEI", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [MOCK_VEHICLE] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      await client.getVehicles({ imei: "353762078072777" });

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("imei=353762078072777");
    });

    it("filters by VIN", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [MOCK_VEHICLE] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      await client.getVehicles({ vin: "JTDKN3DU5A0000001" });

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("vin=JTDKN3DU5A0000001");
    });

    it("throws on API error", async () => {
      globalThis.fetch = mockFetch([
        { ok: false, status: 500, body: { error: "internal_error" } },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      await expect(client.getVehicles()).rejects.toThrow(BouncieApiError);
    });
  });

  describe("getTrips", () => {
    it("fetches trips with required IMEI", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [MOCK_TRIP] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      const trips = await client.getTrips({ imei: "353762078072777" });

      expect(trips).toEqual([MOCK_TRIP]);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/v1/trips");
      expect(url).toContain("imei=353762078072777");
    });

    it("passes all query parameters", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [MOCK_TRIP] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      await client.getTrips({
        imei: "353762078072777",
        gpsFormat: "geojson",
        startsAfter: "2024-06-10",
        endsBefore: "2024-06-15",
        transactionId: "txn-123",
      });

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("gpsFormat=geojson");
      expect(url).toContain("startsAfter=2024-06-10");
      expect(url).toContain("endsBefore=2024-06-15");
      expect(url).toContain("transactionId=txn-123");
    });

    it("works without optional params", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      const trips = await client.getTrips({ imei: "353762078072777" });

      expect(trips).toEqual([]);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).not.toContain("gpsFormat");
      expect(url).not.toContain("startsAfter");
    });
  });

  describe("getUser", () => {
    it("fetches user profile", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: MOCK_USER },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      const user = await client.getUser();

      expect(user).toEqual(MOCK_USER);
      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain("/v1/user");
    });
  });

  describe("token management", () => {
    it("reuses existing valid token", async () => {
      globalThis.fetch = mockFetch([
        { ok: true, status: 200, body: [MOCK_VEHICLE] },
        { ok: true, status: 200, body: [MOCK_VEHICLE] },
      ]) as unknown as typeof fetch;

      const client = createClient({ accessToken: "token" });
      await client.getVehicles();
      await client.getVehicles();

      // Should NOT have called auth endpoint, just 2 API calls
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      for (const call of (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls) {
        expect(call[0]).toContain("/v1/vehicles");
      }
    });

    it("throws when no token and no auth code", async () => {
      const client = createClient({ accessToken: undefined, authorizationCode: undefined });
      // Clear the auth code
      (client as any).config.authorizationCode = undefined;

      globalThis.fetch = mockFetch([]) as unknown as typeof fetch;

      await expect(client.getVehicles()).rejects.toThrow(
        /No access token or authorization code/,
      );
    });
  });
});
