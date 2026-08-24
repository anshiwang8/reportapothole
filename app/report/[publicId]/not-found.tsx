import Link from "next/link";

export default function ReportNotFound() {
  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-bold">Report not found</h1>
      <p className="text-gray-600">
        We couldn&apos;t find a report with that ID. It may have been mistyped, or the report
        may no longer exist.
      </p>
      <Link href="/report" className="border p-2">
        Report a pothole
      </Link>
    </main>
  );
}
