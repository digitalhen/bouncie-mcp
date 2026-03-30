import type {
  BouncieConfig,
  TokenResponse,
  Vehicle,
  Trip,
  TripQuery,
  User,
} from "./types.js";

const API_BASE = "https://api.bouncie.dev/v1";
const AUTH_URL = "https://auth.bouncie.com/oauth/token";

export class BouncieApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
    this.name = "BouncieApiError";
  }
}

export class BouncieClient {
  private config: BouncieConfig;
  private accessToken: string | undefined;
  private tokenExpiresAt: number = 0;

  constructor(config: BouncieConfig) {
    this.config = config;
    this.accessToken = config.accessToken;
    if (this.accessToken) {
      // If token provided directly, assume it's valid for 1 hour
      this.tokenExpiresAt = Date.now() + 3600 * 1000;
    }
  }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    if (!this.config.authorizationCode) {
      throw new BouncieApiError(
        "No access token or authorization code available. Provide either accessToken or authorizationCode in config.",
        401,
      );
    }

    const token = await this.authenticate();
    return token;
  }

  async authenticate(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "authorization_code",
      code: this.config.authorizationCode!,
      redirect_uri: this.config.redirectUri,
    });

    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new BouncieApiError(
        `Authentication failed: ${res.status} ${res.statusText}`,
        res.status,
        text,
      );
    }

    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
    const token = await this.ensureToken();
    const url = new URL(`${API_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: token },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new BouncieApiError(
        `API request failed: ${res.status} ${res.statusText} - ${path}`,
        res.status,
        text,
      );
    }

    return (await res.json()) as T;
  }

  async getVehicles(options?: { imei?: string; vin?: string }): Promise<Vehicle[]> {
    const params: Record<string, string> = {};
    if (options?.imei) params.imei = options.imei;
    if (options?.vin) params.vin = options.vin;
    return this.request<Vehicle[]>("/vehicles", params);
  }

  async getTrips(query: TripQuery): Promise<Trip[]> {
    const params: Record<string, string> = {
      imei: query.imei,
    };
    if (query.transactionId) params.transactionId = query.transactionId;
    if (query.gpsFormat) params.gpsFormat = query.gpsFormat;
    if (query.startsAfter) params.startsAfter = query.startsAfter;
    if (query.endsBefore) params.endsBefore = query.endsBefore;
    return this.request<Trip[]>("/trips", params);
  }

  async getUser(): Promise<User> {
    return this.request<User>("/user");
  }
}
