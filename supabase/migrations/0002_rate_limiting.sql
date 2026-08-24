-- ReportAPothole: rate limiting bookkeeping
--
-- Row Level Security model:
--   This table has no RLS policies at all, by design. It is server-side
--   bookkeeping for the POST /api/reports rate limit only -- read and
--   written exclusively via the Supabase secret key (see
--   lib/supabase/server.ts), which bypasses RLS entirely. RLS is still
--   enabled anyway (defense in depth: an empty policy set means no role
--   other than service_role can see or touch any row, even if a client-side
--   role were ever accidentally granted access to this table).
--
-- ip_hash column:
--   SHA-256 hash of the submitting IP address (see app/api/reports/route.ts),
--   not the raw IP -- per the project's principle of not retaining
--   unnecessary personal data. A hash is sufficient to rate-limit by IP
--   without storing the IP itself.
--
-- TODO: this table grows unbounded -- there is no cleanup/expiry job for
-- rows older than the rate-limit window. Add a periodic cleanup (cron job
-- or scheduled query) once real usage exists; not built here.

create table if not exists rate_limit_events (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_ip_hash_created_at_idx
  on rate_limit_events (ip_hash, created_at);

alter table rate_limit_events enable row level security;

-- No policies defined -- see the Row Level Security model note above. This
-- table is server-bookkeeping only, touched exclusively via the secret key.

-- Table-level grants, matching the pattern in 0001_init.sql: RLS policies
-- only restrict rows an already-granted role can see, so the underlying
-- GRANT is still required. No grant to anon here -- this table has no
-- public access at all.
grant select, insert, update, delete on rate_limit_events to service_role;
