-- ReportAPothole: municipal email submission pipeline
--
-- Sending is hard-gated behind MUNICIPAL_SEND_ENABLED and off by default
-- (see app/api/municipal/send/route.ts) -- the City of Toronto has not
-- granted permission for programmatic submission as of this migration. The
-- columns added here let the app compose and store the email that *would*
-- be sent at report-submission time (app/api/reports/route.ts), without
-- ever sending it.
--
-- reporter_email:
--   Optional contact info supplied by the reporter (app/report/page.tsx),
--   used only as the outbound email's reply-to if/when a submission is
--   ever sent (app/api/municipal/send/route.ts). This is personal data --
--   it must never be exposed on the public map, the public
--   /report/[publicId] page, or any API response. Only read by server-side
--   code holding the secret key (lib/supabase/server.ts).
--
-- municipal_email_subject / municipal_email_body:
--   The plain-text email composed from the report's own data at submission
--   time, stored so it can be reviewed and later sent without recomputing
--   it. Same exposure rule as reporter_email above: never selected into a
--   client-facing response or page.
--
-- municipal_sent_at:
--   Set only by app/api/municipal/send/route.ts on a confirmed-successful
--   send (the email provider actually reported success) -- never
--   optimistically set at composition time.
--
-- municipal_submission_status:
--   Already an unconstrained nullable text column (0001_init.sql). As of
--   this migration it is used with these values:
--     null       -- composition hasn't run yet (e.g. it errored -- see the
--                   edge-case handling in app/api/reports/route.ts)
--     not_sent   -- report is a duplicate (duplicate_of is non-null, see
--                   0004_duplicate_detection.sql); duplicates are never
--                   composed or forwarded to the City
--     pending    -- email composed and stored, not yet sent
--     sent       -- provider confirmed successful delivery
--     failed     -- a send was attempted and the provider did not confirm
--                   success
--   No CHECK constraint is added here, consistent with the column's
--   existing unconstrained definition in 0001_init.sql.

alter table reports
  add column if not exists reporter_email text,
  add column if not exists municipal_email_subject text,
  add column if not exists municipal_email_body text,
  add column if not exists municipal_sent_at timestamptz;
