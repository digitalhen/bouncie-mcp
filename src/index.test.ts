import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Vehicle, Trip, User, TokenResponse } from "./types.js";

// --- Test fixtures ---

const MOCK_TOKEN: TokenResponse = {
  access_token: "mock-token",
  token_type: "Bearer",
  expires_in: 3600,
};

const MOCK_VEHICLE: Vehicle = {
  model: { make: "FORD", name: "F-150", year: 2022 },
  standardEngine: "3.5L V6",
  vin: "1FTEW1EP0NFA00001",
  imei: "860000000000001",
  nickName: "Work Truck",
  stats: {
    localTimeZone: "-0600",
    lastUpdated: "2024-06-15T10:00:00.000Z",
    odometer: 32100,
    location: { lat: 30.2672, lon: -97.7431, heading: 90, address: "Austin, TX" },
    fuelLevel: 85.0,
    isRunning: true,
    speed: 45,
    mil: {
      milOn: false,
      lastUpdated: "2024-06-01T00:00:00.000Z",
      qualifiedDtcList: [],
    },
    battery: { status: "normal", lastUpdated: "2024-06-01T00:00:00.000Z" },
  },
};

const MOCK_TRIP: Trip = {
  transactionId: "860000000000001-100-1718460000000",
  hardBrakingCount: 0,
  hardAccelerationCount: 1,
  distance: 8.3,
  gps: "encoded_polyline",
  startTime: "2024-06-15T08:00:00.000Z",
  endTime: "2024-06-15T08:20:00.000Z",
  startOdometer: 32092,
  endOdometer: 32100,
  averageSpeed: 25.0,
  maxSpeed: 50.0,
  fuelConsumed: 0.6,
  timeZone: "-0600",
};

const MOCK_USER: User = { email: "driver@example.com", name: "Driver" };

// --- Helpers ---

function mockFetchForIntegration() {
  return vi.fn(async (url: string | URL) => {
    const urlStr = url.toString();

    if (urlStr.includes("auth.bouncie.com")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(MOCK_TOKEN),
        json: async () => MOCK_TOKEN,
      };
    }
    if (urlStr.includes("/v1/vehicles")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify([MOCK_VEHICLE]),
        json: async () => [MOCK_VEHICLE],
      };
    }
    if (urlStr.includes("/v1/trips")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify([MOCK_TRIP]),
        json: async () => [MOCK_TRIP],
      };
    }
    if (urlStr.includes("/v1/user")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(MOCK_USER),
        json: async () => MOCK_USER,
      };
    }

    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "Not Found",
      json: async () => ({ error: "not_found" }),
    };
  });
}

describe("Bouncie MCP Server Integration", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.BOUNCIE_CLIENT_ID = "test-id";
    process.env.BOUNCIE_CLIENT_SECRET = "test-secret";
    process.env.BOUNCIE_REDIRECT_URI = "https://example.com/cb";
    process.env.BOUNCIE_ACCESS_TOKEN = "test-token";
    globalThis.fetch = mockFetchForIntegration() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function createServerClient() {
    // Dynamic import so env vars are read at tool call time
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { z } = await import("zod");
    const { BouncieClient } = await import("./api.js");

    const server = new McpServer({ name: "bouncie-test", version: "1.0.0" });

    function makeClient() {
      return new BouncieClient({
        clientId: process.env.BOUNCIE_CLIENT_ID!,
        clientSecret: process.env.BOUNCIE_CLIENT_SECRET!,
        redirectUri: process.env.BOUNCIE_REDIRECT_URI!,
        accessToken: process.env.BOUNCIE_ACCESS_TOKEN,
      });
    }

    server.tool("get_vehicles", { vin: z.string().optional(), imei: z.string().optional() }, async ({ vin, imei }) => {
      const vehicles = await makeClient().getVehicles({ vin, imei });
      return { content: [{ type: "text" as const, text: JSON.stringify(vehicles, null, 2) }] };
    });

    server.tool("get_vehicle", { vin: z.string().optional(), imei: z.string().optional() }, async ({ vin, imei }) => {
      if (!vin && !imei) return { content: [{ type: "text" as const, text: "Provide vin or imei" }], isError: true };
      const vehicles = await makeClient().getVehicles({ vin, imei });
      if (vehicles.length === 0) return { content: [{ type: "text" as const, text: "No vehicle found" }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(vehicles[0], null, 2) }] };
    });

    server.tool(
      "get_trips",
      {
        imei: z.string(),
        starts_after: z.string().optional(),
        ends_before: z.string().optional(),
        gps_format: z.enum(["polyline", "geojson"]).optional(),
        transaction_id: z.string().optional(),
      },
      async ({ imei, starts_after, ends_before, gps_format, transaction_id }) => {
        const trips = await makeClient().getTrips({
          imei,
          startsAfter: starts_after,
          endsBefore: ends_before,
          gpsFormat: gps_format as any,
          transactionId: transaction_id,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(trips, null, 2) }] };
      },
    );

    server.tool("get_user", {}, async () => {
      const user = await makeClient().getUser();
      return { content: [{ type: "text" as const, text: JSON.stringify(user, null, 2) }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return client;
  }

  it("lists all available tools", async () => {
    const client = await createServerClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_trips", "get_user", "get_vehicle", "get_vehicles"]);
  });

  it("get_vehicles returns vehicle list", async () => {
    const client = await createServerClient();
    const result = await client.callTool({ name: "get_vehicles", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const vehicles = JSON.parse(text);

    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].vin).toBe("1FTEW1EP0NFA00001");
    expect(vehicles[0].model.make).toBe("FORD");
    expect(vehicles[0].stats.isRunning).toBe(true);
  });

  it("get_vehicle returns single vehicle by VIN", async () => {
    const client = await createServerClient();
    const result = await client.callTool({
      name: "get_vehicle",
      arguments: { vin: "1FTEW1EP0NFA00001" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const vehicle = JSON.parse(text);

    expect(vehicle.vin).toBe("1FTEW1EP0NFA00001");
    expect(vehicle.nickName).toBe("Work Truck");
  });

  it("get_vehicle errors when no identifier provided", async () => {
    const client = await createServerClient();
    const result = await client.callTool({
      name: "get_vehicle",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("vin or imei");
  });

  it("get_trips returns trips for vehicle", async () => {
    const client = await createServerClient();
    const result = await client.callTool({
      name: "get_trips",
      arguments: {
        imei: "860000000000001",
        starts_after: "2024-06-14",
        ends_before: "2024-06-16",
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const trips = JSON.parse(text);

    expect(trips).toHaveLength(1);
    expect(trips[0].distance).toBe(8.3);
    expect(trips[0].transactionId).toContain("860000000000001");
  });

  it("get_user returns user profile", async () => {
    const client = await createServerClient();
    const result = await client.callTool({ name: "get_user", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const user = JSON.parse(text);

    expect(user.email).toBe("driver@example.com");
    expect(user.name).toBe("Driver");
  });

  it("get_vehicles passes filter parameters", async () => {
    const client = await createServerClient();
    await client.callTool({
      name: "get_vehicles",
      arguments: { imei: "860000000000001" },
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const vehicleCall = fetchMock.mock.calls.find(
      (c: [string, ...unknown[]]) => c[0].toString().includes("/v1/vehicles"),
    );
    expect(vehicleCall).toBeDefined();
    expect(vehicleCall![0].toString()).toContain("imei=860000000000001");
  });

  it("get_trips passes gps_format parameter", async () => {
    const client = await createServerClient();
    await client.callTool({
      name: "get_trips",
      arguments: { imei: "860000000000001", gps_format: "geojson" },
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const tripCall = fetchMock.mock.calls.find(
      (c: [string, ...unknown[]]) => c[0].toString().includes("/v1/trips"),
    );
    expect(tripCall![0].toString()).toContain("gpsFormat=geojson");
  });
});
