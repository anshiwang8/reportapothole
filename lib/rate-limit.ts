import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Shared across every write-adjacent endpoint (POST /api/reports,
// POST /api/photos/upload-url) as one combined per-IP budget against the
// same rate_limit_events table -- not tracked separately per endpoint.
// Placeholder values, not derived from any real-usage analysis -- tune once
// actual traffic patterns are known.
export const MAX_REQUESTS_PER_WINDOW = 5;
export const WINDOW_MINUTES = 10;

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
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return DEV_FALLBACK_IP;
  }
  const firstIp = forwardedFor.split(",")[0]?.trim();
  return firstIp || DEV_FALLBACK_IP;
}

// Raw IPs are never stored, only their hash, per the project's principle of
// not retaining unnecessary personal data (see supabase/migrations/0002_rate_limiting.sql).
export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

/**
 * Checks whether this IP has already hit the rate limit within the current
 * window. Known tradeoff, not solved here: IP-based limiting affects an
 * entire shared office/NAT network as a single bucket, so a burst of
 * legitimate requests from different people behind the same public IP can
 * trip this.
 *
 * On a database error, fails open (allows the request) rather than closed --
 * this is a best-effort abuse-prevention mechanism, not a hard security
 * boundary, consistent with how reverseGeocode in app/api/reports/route.ts
 * treats external/infra failures as best-effort rather than hard blockers.
 */
export async function isRateLimited(
  supabase: SupabaseClient,
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

  return (count ?? 0) >= MAX_REQUESTS_PER_WINDOW;
}

/**
 * Records a request attempt for this IP, regardless of whether the request
 * itself later succeeds or fails other validation -- this tracks request
 * volume, not successful submissions. Failure here is logged and swallowed;
 * it shouldn't block an otherwise-valid request.
 */
export async function recordRateLimitEvent(
  supabase: SupabaseClient,
  ipHash: string
): Promise<void> {
  const { error } = await supabase.from("rate_limit_events").insert({ ip_hash: ipHash });
  if (error) {
    console.error("Failed to record rate limit event:", error);
  }
}
