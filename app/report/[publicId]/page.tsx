import { notFound } from "next/navigation";
import { createServerReadClient } from "@/lib/supabase/server-read";
import ReportMap from "./report-map";

interface ReportRow {
  public_id: string;
  latitude: number;
  longitude: number;
  address: string | null;
  municipality: string | null;
  province: string | null;
  photo_url: string | null;
  description: string | null;
  severity: "low" | "medium" | "high" | null;
  status:
    | "saved"
    | "pending_municipal_submission"
    | "sent"
    | "service_request_created"
    | "acknowledged"
    | "resolved";
  municipal_submission_status: string | null;
  created_at: string;
}

// Exact CHECK-constraint values from supabase/migrations/0001_init.sql.
const SEVERITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const STATUS_LABELS: Record<string, string> = {
  saved: "Saved",
  pending_municipal_submission: "Pending municipal submission",
  sent: "Sent",
  service_request_created: "Service request created",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
};

export default async function ReportDetailPage(props: PageProps<"/report/[publicId]">) {
  const { publicId } = await props.params;
  const searchParams = await props.searchParams;
  const justCreated = searchParams.created === "1";

  const supabase = createServerReadClient();
  const { data, error } = await supabase
    .from("reports")
    .select(
      "public_id, latitude, longitude, address, municipality, province, photo_url, description, severity, status, municipal_submission_status, created_at"
    )
    .eq("public_id", publicId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load report: ${error.message}`);
  }

  if (!data) {
    notFound();
  }

  const report = data as ReportRow;
  const formattedDate = new Date(report.created_at).toLocaleDateString();
  const locationLine = [report.municipality, report.province].filter(Boolean).join(", ");

  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Pothole Report</h1>
      <div className="flex w-full max-w-sm flex-col gap-3">
        {justCreated && (
          <p className="border border-green-600 bg-green-50 p-2 text-sm text-green-800">
            Report submitted successfully — here&apos;s your report.
          </p>
        )}
        <p className="text-sm text-gray-600">
          Report ID: <strong>{report.public_id}</strong>
        </p>

        <ReportMap latitude={report.latitude} longitude={report.longitude} />

        {(report.address || locationLine) && (
          <div>
            {report.address && <p>{report.address}</p>}
            {locationLine && <p className="text-sm text-gray-600">{locationLine}</p>}
          </div>
        )}

        {report.photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- external, arbitrary photo URL; no next.config.ts image domains configured yet
          <img
            src={report.photo_url}
            alt="Photo of the reported pothole"
            className="w-full border"
          />
        ) : (
          <p className="text-sm text-gray-500">No photo submitted.</p>
        )}

        {report.description && <p>{report.description}</p>}

        <dl className="flex flex-col gap-1 text-sm">
          {report.severity && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-600">Severity</dt>
              <dd>{SEVERITY_LABELS[report.severity] ?? report.severity}</dd>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <dt className="text-gray-600">Status</dt>
            <dd>{STATUS_LABELS[report.status] ?? report.status}</dd>
          </div>
          {report.municipal_submission_status && (
            <div className="flex justify-between gap-2">
              <dt className="text-gray-600">Municipal submission status</dt>
              <dd>{report.municipal_submission_status}</dd>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <dt className="text-gray-600">Reported on</dt>
            <dd>{formattedDate}</dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
