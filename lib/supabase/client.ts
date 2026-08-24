import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-safe Supabase client for public, read-only queries, plus
 * signed-URL-authorized Storage uploads. Uses the publishable key, which is
 * subject to Row Level Security -- it can only do what the anon-role RLS
 * policies allow (SELECT on reports).
 *
 * Never use this client for privileged writes gated by RLS or role grants
 * (e.g. inserting into reports directly) -- those go through server Route
 * Handlers with the secret key. It IS safe to use this client for
 * `storage.from(...).uploadToSignedUrl(...)`: that authorization comes from
 * the short(ish)-lived token a server route mints with the secret key (see
 * app/api/photos/upload-url/route.ts), not from this client's own role
 * permissions -- per the Supabase Storage SDK, no RLS/grant permissions on
 * the bucket or objects table are required for that specific call.
 */
export function createBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables."
    );
  }

  return createClient(url, publishableKey);
}
