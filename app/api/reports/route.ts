import { randomInt, createHash } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";

const ALLOWED_SEVERITIES = ["low", "medium", "high"] as const;
type Severity = (typeof ALLOWED_SEVERITIES)[number];

function isAllowedSeverity(value: string): value is Severity {
  return (ALLOWED_SEVERITIES as readonly string[]).includes(value);
}

// Coarse Canada-wide bounding box used as a sanity filter only -- it is NOT
// real municipality/country detection. Plenty of points inside this box are
// not in Canada (it also covers parts of the US and open ocean), and it
// exists purely to reject obviously-wrong coordinates (e.g. a typo that
// lands in the Indian Ocean) before they hit the database.
const CANADA_BBOX = {
  latMin: 41,
  latMax: 84,
  lngMin: -141,
  lngMax: -52,
};

// Placeholder values, not derived from any real-usage analysis -- tune once
// actual traffic patterns are known.
const MAX_REPORTS_PER_WINDOW = 5;
const WINDOW_MINUTES = 10;

// Dev-only fallback when x-forwarded-for is absent, e.g. local `next dev`,
// which isn't behind a proxy that sets it. Every unidentified local request
// shares one rate-limit bucket -- fine for local development, never expected
// in production behind Vercel's edge network (which sets x-forwarded-for on
// every request). NextRequest's old `.ip`/`.geo` properties were removed in
// Next.js 15, so reading this header directly is the current approach.
const DEV_FALLBACK_IP = "unknown-dev-ip";

/**
 * x-forwarded-for can carry a comma-separated proxy chain
 * ("client, proxy1, proxy2"); the first entry is the original client.
 */
function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return DEV_FALLBACK_IP;
  }
  const firstIp = forwardedFor.split(",")[0]?.trim();
  return firstIp || DEV_FALLBACK_IP;
}

// Raw IPs are never stored, only their hash, per the project's principle of
// not retaining unnecessary personal data (see supabase/migrations/0002_rate_limiting.sql).
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/**
 * Checks whether this IP has already hit the rate limit within the current
 * window. Known tradeoff, not solved here: IP-based limiting affects an
 * entire shared office/NAT network as a single bucket, so a burst of
 * legitimate requests from different people behind the same public IP can
 * trip this.
 *
 * On a database error, fails open (allows the request) rather than closed,
 * consistent with how reverseGeocode below treats external/infra failures
 * as best-effort rather than hard blockers on report submission.
 */
async function isRateLimited(
  supabase: ReturnType<typeof createServerClient>,
  ipHash: string
): Promise<boolean> {
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();

  const { count, error } = await supabase
    .from("rate_limit_events")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", windowStart);

  if (error) {
    console.error("Rate limit check failed; failing open:", error);
    return false;
  }

  return (count ?? 0) >= MAX_REPORTS_PER_WINDOW;
}

/**
 * Records a request attempt for this IP, regardless of whether the report
 * submission itself later succeeds or fails other validation -- this tracks
 * request volume, not successful submissions. Failure here is logged and
 * swallowed; it shouldn't block an otherwise-valid report.
 */
async function recordRateLimitEvent(
  supabase: ReturnType<typeof createServerClient>,
  ipHash: string
): Promise<void> {
  const { error } = await supabase.from("rate_limit_events").insert({ ip_hash: ipHash });
  if (error) {
    console.error("Failed to record rate limit event:", error);
  }
}

const DESCRIPTION_MAX_LENGTH = 1000;

const PUBLIC_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const PUBLIC_ID_LENGTH = 8;
const MAX_INSERT_ATTEMPTS = 3;

// Postgres unique_violation SQLSTATE, returned by PostgREST as `code`.
const POSTGRES_UNIQUE_VIOLATION = "23505";

function generatePublicId(): string {
  let id = "";
  for (let i = 0; i < PUBLIC_ID_LENGTH; i++) {
    id += PUBLIC_ID_ALPHABET[randomInt(PUBLIC_ID_ALPHABET.length)];
  }
  return id;
}

interface GeocodeResult {
  address: string | null;
  municipality: string | null;
  province: string | null;
}

const NO_GEOCODE_RESULT: GeocodeResult = {
  address: null,
  municipality: null,
  province: null,
};

const GEOCODE_TIMEOUT_MS = 5000;

/**
 * Reverse geocodes with Mapbox's v6 API using permanent=true, since the
 * result is stored (not just displayed), per Mapbox's storage terms.
 * Geocoding is best-effort: any failure (missing token, network error,
 * timeout, non-2xx response) is logged and swallowed so it never blocks
 * report submission -- callers get null fields instead of a thrown error.
 */
async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<GeocodeResult> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) {
    console.error(
      "Reverse geocoding skipped: NEXT_PUBLIC_MAPBOX_TOKEN is not set."
    );
    return NO_GEOCODE_RESULT;
  }

  const url = new URL("https://api.mapbox.com/search/geocode/v6/reverse");
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("access_token", token);
  url.searchParams.set("permanent", "true");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      console.error(
        `Reverse geocoding failed with HTTP ${response.status} for (${latitude}, ${longitude}).`
      );
      return NO_GEOCODE_RESULT;
    }

    const data = await response.json();
    const feature = data?.features?.[0];
    if (!feature) {
      return NO_GEOCODE_RESULT;
    }

    const properties = feature.properties ?? {};
    const context = properties.context ?? {};

    return {
      address: properties.full_address ?? properties.place_formatted ?? null,
      municipality: context.place?.name ?? null,
      province: context.region?.name ?? null,
    };
  } catch (error) {
    console.error(
      `Reverse geocoding threw for (${latitude}, ${longitude}):`,
      error
    );
    return NO_GEOCODE_RESULT;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface ReportInsert {
  latitude: number;
  longitude: number;
  description: string | null;
  severity: Severity | null;
  address: string | null;
  municipality: string | null;
  province: string | null;
}

interface ReportRow {
  public_id: string;
  latitude: number;
  longitude: number;
  address: string | null;
  municipality: string | null;
  province: string | null;
  status: string;
}

/**
 * Inserts a report with a freshly generated public_id, retrying with a new
 * id on a unique-constraint collision (astronomically unlikely at 8 chars
 * of base62, but cheap to handle). Any other database error aborts
 * immediately rather than retrying.
 */
async function insertReportWithRetry(
  supabase: ReturnType<typeof createServerClient>,
  report: ReportInsert
): Promise<{ data: ReportRow | null; error: { message: string } | null }> {
  let lastError: { message: string } | null = null;

  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    const public_id = generatePublicId();

    const { data, error } = await supabase
      .from("reports")
      .insert({ ...report, public_id })
      .select("public_id, latitude, longitude, address, municipality, province, status")
      .single();

    if (!error) {
      return { data: data as ReportRow, error: null };
    }

    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      lastError = error;
      continue;
    }

    return { data: null, error };
  }

  return { data: null, error: lastError };
}

export async function POST(request: Request) {
  const supabase = createServerClient();
  const ipHash = hashIp(getClientIp(request));

  // Checked before anything else -- including JSON parsing -- so a request
  // that would ultimately fail validation still counts against the caller's
  // volume, and so a rate-limited caller never reaches the Mapbox geocode
  // call further down.
  if (await isRateLimited(supabase, ipHash)) {
    return Response.json(
      { error: "Too many reports submitted recently. Please try again later." },
      { status: 429 }
    );
  }
  await recordRateLimitEvent(supabase, ipHash);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  const { latitude, longitude, description, severity } =
    body as Record<string, unknown>;

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude)
  ) {
    return Response.json(
      { error: "latitude and longitude are required and must be finite numbers." },
      { status: 400 }
    );
  }

  if (
    latitude < CANADA_BBOX.latMin ||
    latitude > CANADA_BBOX.latMax ||
    longitude < CANADA_BBOX.lngMin ||
    longitude > CANADA_BBOX.lngMax
  ) {
    return Response.json(
      { error: "Coordinates fall outside the supported area." },
      { status: 400 }
    );
  }

  let normalizedDescription: string | null = null;
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") {
      return Response.json(
        { error: "description must be a string." },
        { status: 400 }
      );
    }
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      return Response.json(
        { error: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters.` },
        { status: 400 }
      );
    }
    normalizedDescription = description;
  }

  let normalizedSeverity: Severity | null = null;
  if (severity !== undefined && severity !== null) {
    if (typeof severity !== "string" || !isAllowedSeverity(severity)) {
      return Response.json(
        { error: `severity must be one of: ${ALLOWED_SEVERITIES.join(", ")}.` },
        { status: 400 }
      );
    }
    normalizedSeverity = severity;
  }

  try {
    const geocode = await reverseGeocode(latitude, longitude);

    const { data, error } = await insertReportWithRetry(supabase, {
      latitude,
      longitude,
      description: normalizedDescription,
      severity: normalizedSeverity,
      address: geocode.address,
      municipality: geocode.municipality,
      province: geocode.province,
    });

    if (error || !data) {
      console.error("Failed to insert pothole report:", error);
      return Response.json(
        { error: "Failed to save report. Please try again." },
        { status: 500 }
      );
    }

    return Response.json(
      {
        public_id: data.public_id,
        latitude: data.latitude,
        longitude: data.longitude,
        address: data.address,
        municipality: data.municipality,
        province: data.province,
        status: data.status,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Unexpected error handling pothole report submission:", error);
    return Response.json(
      { error: "Unexpected server error." },
      { status: 500 }
    );
  }
}
