import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only Supabase client for Server Components, using the publishable
 * key. Reads are bound by the anon-role RLS policy (public SELECT on
 * reports) -- the same permissions as the browser client in client.ts, just
 * without assuming a browser storage API is available for session handling.
 * Never use this for writes; those go through the secret server client in
 * server.ts, from Route Handlers only.
 */
export function createServerReadClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY environment variables."
    );
  }

  return createClient(url, publishableKey, {
    auth: {
      persistSession: false,
    },
  });
}
