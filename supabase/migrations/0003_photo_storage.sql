-- ReportAPothole: photo storage bucket
--
-- Security model:
--   This bucket is public for READS (no auth required to view a photo) --
--   that's required, since photos display on the already-public
--   /report/[publicId] page. It is NOT public for writes: no bucket
--   policies grant the anon role insert/update/delete on storage.objects
--   for this bucket, so a client can never upload directly. All uploads
--   happen through a short(ish)-lived signed upload URL minted server-side
--   with the Supabase secret key (see app/api/photos/upload-url/route.ts),
--   scoped to one specific, server-generated random path. The secret key
--   bypasses RLS the same way it does for the `reports` and
--   `rate_limit_events` tables (see lib/supabase/server.ts).
--
--   Note: as of the installed @supabase/storage-js version (2.112.3),
--   createSignedUploadUrl() has no expiresIn option -- signed upload URLs
--   are valid for a platform-fixed 2 hours, not a custom short window. This
--   is a real SDK/platform limitation, not a choice made here. The random,
--   unguessable per-upload path plus the server-side existence check before
--   a photo path is ever persisted (see app/api/reports/route.ts) are the
--   actual defenses against misuse, not the token's expiry window.
--
-- file_size_limit is in bytes (confirmed against the storage service's own
-- migrations: max_file_size_kb was renamed to file_size_limit and converted
-- to bytes). allowed_mime_types includes HEIC/HEIF alongside JPEG/PNG/WebP
-- because iOS Safari's HEIC-to-JPEG conversion on file-input upload is
-- inconsistent across versions (confirmed via research, not assumed) --
-- rejecting HEIC/HEIF here would break real iPhone photo uploads for some
-- users.
--
-- This bucket may not exist yet if this migration hasn't been applied --
-- see the session report for whether it applied via SQL or required manual
-- Supabase Dashboard creation.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-photos',
  'report-photos',
  true,
  10485760, -- 10 MB, in bytes
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
