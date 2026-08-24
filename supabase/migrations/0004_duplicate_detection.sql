-- ReportAPothole: invisible duplicate detection
--
-- duplicate_of column:
--   Set by the server (app/api/reports/route.ts) at submission time when a
--   new report's coordinates land within DUPLICATE_RADIUS_METERS of an
--   existing, non-duplicate, unresolved report. This column is invisible to
--   end users by design -- it is never selected into an API response and
--   never surfaces in any UI. A non-null value means "not shown on the
--   public map" (see app/map/page.tsx's query filter); it does NOT mean the
--   row is deleted, hidden from its own /report/[publicId] permalink, or
--   otherwise treated differently for the submitter, who sees the exact
--   same confirmation flow either way.
--
--   `on delete set null` (rather than cascade) is intentional: if the
--   original report a duplicate points to is ever removed, the duplicate
--   should fall back to being treated as its own genuine report, not be
--   deleted as a side effect.

alter table reports
  add column if not exists duplicate_of uuid references reports(id) on delete set null;

-- Matches the reports_lat_lng_idx / reports_public_id_idx naming convention
-- in 0001_init.sql. Supports both the `duplicate_of IS NULL` filters (map
-- query, and the duplicate-candidate query itself, which must only compare
-- against genuine reports) and lookups by original report id.
create index if not exists reports_duplicate_of_idx on reports (duplicate_of);
