import { createServerReadClient } from "@/lib/supabase/server-read";
import AllReportsMap, { type MapReport } from "./all-reports-map";

// Without this, the route has no request-time API (no cookies/headers/
// searchParams) so Next would prerender it once at build time and freeze the
// report list until the next deploy -- not what a "current reports" map needs.
export const dynamic = "force-dynamic";

// Defensive cap for the current MVP -- no pagination or clustering yet, so
// this bounds the query and marker count as report volume grows.
const REPORT_LIMIT = 500;

export default async function MapPage() {
  const supabase = createServerReadClient();
  const { data, error } = await supabase
    .from("reports")
    .select("public_id, latitude, longitude, status")
    .order("created_at", { ascending: false })
    .limit(REPORT_LIMIT);

  if (error) {
    throw new Error(`Failed to load reports: ${error.message}`);
  }

  // latitude/longitude are `not null` on the reports table
  // (supabase/migrations/0001_init.sql), so no defensive null-filtering is
  // needed here.
  const reports = (data ?? []) as MapReport[];

  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Pothole map</h1>
      <div className="w-full max-w-3xl">
        <AllReportsMap reports={reports} />
      </div>
    </main>
  );
}
