import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";
import { getClientIp, hashIp, isRateLimited, recordRateLimitEvent } from "@/lib/rate-limit";

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

const PHOTO_BUCKET = "report-photos";

/**
 * Confirms an object actually exists at this exact path in the photo
 * bucket, using the secret client. A client-supplied path must never be
 * trusted blindly -- without this check, photoPath would become an
 * arbitrary user-controlled string persisted and rendered publicly.
 *
 * Fails CLOSED (treats an error as "does not exist") unlike the rate-limit
 * check above, which fails open -- this check is a security boundary
 * against unverified user input, not a best-effort abuse-prevention signal.
 */
async function photoExistsAtPath(supabase: SupabaseClient, path: string): Promise<boolean> {
  const lastSlashIndex = path.lastIndexOf("/");
  const folder = lastSlashIndex === -1 ? "" : path.slice(0, lastSlashIndex);
  const filename = lastSlashIndex === -1 ? path : path.slice(lastSlashIndex + 1);

  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .list(folder, { search: filename, limit: 1 });

  if (error) {
    console.error("Failed to check photo existence:", error);
    return false;
  }

  return (data ?? []).some((file) => file.name === filename);
}

// Placeholder distance threshold for the invisible duplicate check below,
// untuned -- same spirit as MAX_REQUESTS_PER_WINDOW in lib/rate-limit.ts.
// Revisit once real submission density/GPS accuracy patterns are known.
const DUPLICATE_RADIUS_METERS = 25;

const EARTH_RADIUS_METERS = 6_371_000;
const METERS_PER_DEGREE_LATITUDE = 111_320;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

interface DuplicateCandidate {
  id: string;
  latitude: number;
  longitude: number;
}

/**
 * Finds an existing, unresolved, non-duplicate report within
 * DUPLICATE_RADIUS_METERS of the given coordinates, if any. A small
 * bounding-box pre-filter on the indexed latitude/longitude columns
 * (reports_lat_lng_idx, supabase/migrations/0001_init.sql) keeps the
 * candidate set small; precise Haversine distance is then computed in
 * application code against just that set. No PostGIS.
 *
 * `duplicate_of IS NULL` ensures this only ever matches against genuine
 * reports -- a report that is itself flagged as a duplicate can never be
 * chosen as the "original" for a later submission.
 *
 * Best-effort only, like the rate-limit check in lib/rate-limit.ts: on a
 * query error, fails open (treats it as no match) so an infra hiccup here
 * never blocks a legitimate submission, and two reports submitted for the
 * same real pothole at nearly the same instant may both miss each other --
 * an accepted tradeoff, not a hard concurrency guarantee.
 */
async function findDuplicateReportId(
  supabase: ReturnType<typeof createServerClient>,
  latitude: number,
  longitude: number
): Promise<string | null> {
  const latDelta = DUPLICATE_RADIUS_METERS / METERS_PER_DEGREE_LATITUDE;
  const metersPerDegreeLongitude =
    METERS_PER_DEGREE_LATITUDE * Math.cos(toRadians(latitude));
  const lonDelta = DUPLICATE_RADIUS_METERS / metersPerDegreeLongitude;

  const { data, error } = await supabase
    .from("reports")
    .select("id, latitude, longitude")
    .neq("status", "resolved")
    .is("duplicate_of", null)
    .gte("latitude", latitude - latDelta)
    .lte("latitude", latitude + latDelta)
    .gte("longitude", longitude - lonDelta)
    .lte("longitude", longitude + lonDelta);

  if (error) {
    console.error("Duplicate check query failed; treating as no match:", error);
    return null;
  }

  const candidates = (data ?? []) as DuplicateCandidate[];
  const match = candidates.find(
    (candidate) =>
      haversineDistanceMeters(latitude, longitude, candidate.latitude, candidate.longitude) <=
      DUPLICATE_RADIUS_METERS
  );

  return match?.id ?? null;
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
  photo_url: string | null;
  duplicate_of: string | null;
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

  const { latitude, longitude, description, severity, photoPath } =
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

  // Runs after the rate-limit check (no expensive work on requests that
  // aren't even allowed) but before the Mapbox geocode call below (no
  // reason to geocode a request that's about to be rejected for a bad
  // photo reference).
  let normalizedPhotoUrl: string | null = null;
  if (photoPath !== undefined && photoPath !== null) {
    if (typeof photoPath !== "string" || photoPath === "") {
      return Response.json(
        { error: "photoPath must be a non-empty string." },
        { status: 400 }
      );
    }

    const exists = await photoExistsAtPath(supabase, photoPath);
    if (!exists) {
      return Response.json(
        { error: "The referenced photo could not be found. Please try uploading it again." },
        { status: 400 }
      );
    }

    normalizedPhotoUrl = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(photoPath).data.publicUrl;
  }

  try {
    const geocode = await reverseGeocode(latitude, longitude);
    const duplicateOfId = await findDuplicateReportId(supabase, latitude, longitude);

    const { data, error } = await insertReportWithRetry(supabase, {
      latitude,
      longitude,
      description: normalizedDescription,
      severity: normalizedSeverity,
      address: geocode.address,
      municipality: geocode.municipality,
      province: geocode.province,
      photo_url: normalizedPhotoUrl,
      duplicate_of: duplicateOfId,
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
