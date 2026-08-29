// Bouncie API type definitions

export interface BouncieConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  authorizationCode?: string;
  accessToken?: string;
}

// --- Vehicle types ---

export interface VehicleModel {
  make: string;
  name: string;
  year: number;
}

export interface VehicleLocation {
  lat: number;
  lon: number;
  heading: number;
  address: string | null;
}

export interface DiagnosticTroubleCode {
  code: string;
  name: string[];
}

export interface VehicleMil {
  milOn: boolean;
  lastUpdated: string;
  qualifiedDtcList: DiagnosticTroubleCode[];
  dtcCount?: number;
}

export interface VehicleBattery {
  status: string;
  lastUpdated: string;
}

export interface VehicleStats {
  localTimeZone: string;
  lastUpdated: string;
  odometer: number;
  location: VehicleLocation;
  fuelLevel: number;
  isRunning: boolean;
  speed: number;
  mil: VehicleMil;
  battery: VehicleBattery;
}

export interface Vehicle {
  model: VehicleModel;
  standardEngine: string;
  vin: string;
  imei: string;
  nickName: string;
  stats: VehicleStats;
}

// --- Trip types ---

export type GpsFormat = "polyline" | "geojson";

export interface TripQuery {
  imei: string;
  transactionId?: string;
  gpsFormat?: GpsFormat;
  startsAfter?: string;
  endsBefore?: string;
}

/**
 * A trip still in progress omits its summary metrics and returns a null
 * endOdometer, so everything the vehicle only knows once the trip ends is
 * optional here. Note also that startOdometer is rounded while endOdometer is
 * not — never derive distance by differencing odometer readings across trips.
 */
export interface Trip {
  transactionId: string;
  hardBrakingCount: number;
  hardAccelerationCount: number;
  /** Miles. Absent while a trip is in progress; 0 for an idle event. */
  distance?: number;
  /** Omitted when the caller does not request GPS. */
  gps?: string | GeoJSONData;
  startTime: string;
  /** Absent while a trip is in progress. */
  endTime?: string;
  /** Miles, rounded to the nearest whole mile. */
  startOdometer: number;
  /** Miles, unrounded. Null while a trip is in progress. */
  endOdometer?: number | null;
  averageSpeed?: number;
  /** Quantized to whole km/h upstream — round before displaying. */
  maxSpeed?: number;
  fuelConsumed?: number;
  /** Seconds spent stopped during the trip. */
  totalIdleDuration?: number;
  timeZone: string;
}

export interface GeoJSONData {
  type: string;
  coordinates: number[][];
}

// --- User types ---

export interface User {
  email?: string;
  name?: string;
  [key: string]: unknown;
}

// --- Webhook event types ---

export type WebhookEventType =
  | "connect"
  | "disconnect"
  | "battery"
  | "mil"
  | "tripStart"
  | "tripEnd"
  | "tripMetrics"
  | "tripData";

export interface WebhookEventBase {
  eventType: WebhookEventType;
  imei: string;
  vin: string;
}

export interface ConnectEvent extends WebhookEventBase {
  eventType: "connect";
  connect: {
    timestamp: string;
    timeZone: string;
    latitude: number;
    longitude: number;
  };
}

export interface DisconnectEvent extends WebhookEventBase {
  eventType: "disconnect";
  disconnect: {
    timestamp: string;
    timeZone: string;
    latitude: number;
    longitude: number;
  };
}

export interface BatteryEvent extends WebhookEventBase {
  eventType: "battery";
  battery: {
    timestamp: string;
    value: string;
  };
}

export interface MilEvent extends WebhookEventBase {
  eventType: "mil";
  mil: {
    timestamp: string;
    value: string;
    codes: string;
  };
}

export interface TripStartEvent extends WebhookEventBase {
  eventType: "tripStart";
  transactionId: string;
  start: {
    timestamp: string;
    timeZone: string;
    odometer: number;
  };
}

export interface TripEndEvent extends WebhookEventBase {
  eventType: "tripEnd";
  transactionId: string;
  end: {
    timestamp: string;
    timeZone: string;
    odometer: number;
    fuelConsumed: number;
  };
}

export interface TripMetricsEvent extends WebhookEventBase {
  eventType: "tripMetrics";
  transactionId: string;
  metrics: {
    timestamp: string;
    tripTime: number;
    tripDistance: number;
    totalIdlingTime: number;
    maxSpeed: number;
    averageDriveSpeed: number;
    hardBrakingCounts: number;
    hardAccelerationCounts: number;
  };
}

export interface TripDataPoint {
  timestamp: string;
  speed?: number;
  gps: {
    lat: number;
    lon: number;
    heading: number;
  };
  fuelLevelInput?: number;
}

export interface TripDataEvent extends WebhookEventBase {
  eventType: "tripData";
  transactionId: string;
  data: TripDataPoint[];
}

export type WebhookEvent =
  | ConnectEvent
  | DisconnectEvent
  | BatteryEvent
  | MilEvent
  | TripStartEvent
  | TripEndEvent
  | TripMetricsEvent
  | TripDataEvent;

// --- Auth types ---

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}
