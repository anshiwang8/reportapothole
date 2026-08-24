import Link from "next/link";

// Wraps both app/report/page.tsx and app/report/[publicId]/page.tsx (and its
// not-found.tsx). Sibling routes like app/map/ are unaffected -- layouts only
// apply to their own segment and descendants.
export default function ReportLayout({ children }: LayoutProps<"/report">) {
  return (
    <>
      <header className="flex justify-end p-4">
        <Link href="/map" className="border p-2">
          Potholes
        </Link>
      </header>
      {children}
    </>
  );
}
