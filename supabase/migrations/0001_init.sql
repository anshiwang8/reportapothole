-- ReportAPothole: initial schema
--
-- Row Level Security model:
--   This app has no user authentication. Public visitors read data through
--   the browser client using the anon role, which is granted SELECT only
--   via the policy below. All writes (INSERT/UPDATE/DELETE) happen through
--   server-side Route Handlers using the Supabase secret key, which bypasses
--   RLS entirely. Do not add anon INSERT/UPDATE/DELETE policies here -- if
--   public write access is ever needed, it should go through a server route
--   that can validate and rate-limit the request, not direct anon writes.
--
-- municipality / province columns:
--   These are display-only placeholders for now. They are not populated by
--   any automated process yet and carry no guarantee of accuracy. Which
--   municipality/province a report is actually routed to for submission
--   will be determined by separate, authoritative routing logic added later
--   (not by trusting these free-text columns).

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  public_id text unique not null,
  latitude double precision not null,
  longitude double precision not null,
  address text,
  municipality text,
  province text,
  photo_url text,
  description text,
  severity text check (severity in ('low', 'medium', 'high')),
  status text not null default 'saved' check (
    status in (
      'saved',
      'pending_municipal_submission',
      'sent',
      'service_request_created',
      'acknowledged',
      'resolved'
    )
  ),
  municipal_submission_status text,
  created_at timestamptz not null default now()
);

create index if not exists reports_lat_lng_idx on reports (latitude, longitude);
create index if not exists reports_public_id_idx on reports (public_id);

alter table reports enable row level security;

-- Public reads only. Writes happen via the secret key (server-side), which
-- bypasses RLS, so no anon insert/update/delete policy is defined here.
create policy "Public reports are viewable by everyone"
  on reports
  for select
  to anon
  using (true);
