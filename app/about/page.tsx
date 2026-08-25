export default function AboutPage() {
  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-8">
      <h1 className="text-2xl font-bold">About &amp; Privacy</h1>
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <p>
          ReportAPothole is a small, independent project built by An Shi Wang, an
          engineering student at McMaster University, to make reporting potholes in
          Toronto faster and easier. It is not an official City of Toronto service,
          and it is not affiliated with, endorsed by, or operated by the City of
          Toronto or 311 Toronto.
        </p>

        <h2 className="text-xl font-bold">What this site collects</h2>

        <p>
          <strong>Location.</strong> The coordinates you provide — by GPS, by selecting an
          intersection, or by placing or dragging a pin on the map. This is the core
          information the app needs to work.
        </p>

        <p>
          <strong>Photo (optional).</strong> If you attach one, it&apos;s processed in your browser
          to strip hidden metadata — including embedded GPS location and timestamp —
          before it&apos;s uploaded.
        </p>

        <p>
          <strong>Description and severity (optional).</strong> Whatever text you choose to add.
        </p>

        <p>
          <strong>Email address (optional).</strong> Only if you choose to provide one. It&apos;s
          stored privately and never shown publicly.
        </p>

        <p>
          <strong>Basic technical information.</strong> Your IP address is hashed, not stored in
          readable form, and used only to prevent abuse such as automated spam
          submissions.
        </p>

        <p>
          <strong>Site usage.</strong> This site uses Vercel Web Analytics, a cookie-free
          analytics tool that reports anonymous, aggregated traffic and cannot identify
          you individually or track you across other websites.
        </p>

        <h2 className="text-xl font-bold">What&apos;s shown publicly</h2>
        <p>
          Your coordinates, photo (if provided), description, severity, and status
          appear on the public map and on your report&apos;s own page, which anyone with
          the link can view. Your email address, if you provide one, is never shown
          publicly under any circumstances.
        </p>

        <h2 className="text-xl font-bold">Duplicate reports</h2>
        <p>
          To keep the public map useful, a new report that appears to describe the
          same pothole as an existing, unresolved report may be automatically
          identified and excluded from the map. Your own report is still saved, and
          its page still works normally either way.
        </p>

        <h2 className="text-xl font-bold">Reporting to the City of Toronto</h2>
        <p>
          Toronto&apos;s public API for submitting service requests is no longer active.
          ReportAPothole is exploring whether reports can be forwarded to the City by
          email, with the City&apos;s knowledge and permission. This feature is not active
          yet — no report is currently sent to the City or to 311 automatically. If
          that changes, this page will be updated, and a report will only ever be
          marked &quot;sent&quot; if it genuinely was.
        </p>

        <h2 className="text-xl font-bold">Third-party services this site relies on</h2>
        <p>
          Supabase (database and photo storage), Mapbox (maps and geocoding), and
          Vercel (hosting and analytics). Each may process data as needed to make the
          site function — for example, resolving an address from coordinates — but
          none are permitted to use it to identify you personally.
        </p>
        <p>
          Data from the City of Toronto&apos;s Centreline Intersection dataset powers the
          intersection search on this site. Contains information licensed under the
          Open Government Licence – Toronto.
        </p>

        <h2 className="text-xl font-bold">Your choices</h2>
        <p>
          There are no accounts on this site. If you provided an email address with a
          report and would like it removed, reach out through anshiwang.com and it
          will be deleted.
        </p>

        <h2 className="text-xl font-bold">A request</h2>
        <p>
          Please avoid photos that clearly show identifiable people, faces, or license
          plates. This is a public map, and photos on it are visible to anyone.
        </p>

        <h2 className="text-xl font-bold">Contact</h2>
        <p>
          Questions about this page or this project: reach out through anshiwang.com.
        </p>

        <p className="text-sm text-gray-600">Last updated August 24, 2026.</p>
      </div>
    </main>
  );
}
