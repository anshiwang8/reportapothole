import "server-only";

/**
 * Plain-text data needed to compose the municipal submission email. Deliberately
 * takes the same values app/api/reports/route.ts already has in hand from the
 * insert it just performed, rather than re-querying -- no extra DB round trip.
 */
export interface MunicipalEmailReport {
  publicId: string;
  latitude: number;
  longitude: number;
  address: string | null;
  municipality: string | null;
  province: string | null;
  description: string | null;
  severity: "low" | "medium" | "high" | null;
  photoUrl: string | null;
  createdAt: string;
}

export interface ComposedMunicipalEmail {
  subject: string;
  body: string;
}

/**
 * Composes the plain-text email a human 311 CSR would read -- no HTML, no
 * marketing language, and no claim that this is an official service
 * request (it isn't one; see AGENTS.md context for why this exists but is
 * gated off). `origin` is the request's own origin (see
 * app/api/reports/route.ts), used to build the report's permalink.
 */
export function composeMunicipalEmail(
  report: MunicipalEmailReport,
  origin: string
): ComposedMunicipalEmail {
  const locationLine = [report.municipality, report.province]
    .filter((part): part is string => Boolean(part))
    .join(", ");

  const subject = `Pothole report ${report.publicId}`;

  const body = [
    "Pothole report submitted via ReportAPothole, a citizen pothole-reporting tool (not an official City of Toronto service).",
    "",
    `Report ID: ${report.publicId}`,
    `Permalink: ${origin}/report/${report.publicId}`,
    "",
    "Location:",
    `  Coordinates: ${report.latitude}, ${report.longitude}`,
    `  Address: ${report.address ?? "Not available"}`,
    `  Municipality/Province: ${locationLine || "Not available"}`,
    "",
    `Severity: ${report.severity ?? "Not specified"}`,
    "",
    "Description:",
    report.description ?? "No description provided.",
    "",
    `Photo: ${report.photoUrl ?? "No photo submitted."}`,
    "",
    `Reported at: ${new Date(report.createdAt).toISOString()}`,
  ].join("\n");

  return { subject, body };
}
