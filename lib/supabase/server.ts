import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using the secret key, which bypasses Row
 * Level Security entirely. The `server-only` import guarantees a build
 * error if this module is ever pulled into a client component bundle.
 * Only use this from Route Handlers / server code, and only for writes
 * or reads that must skip RLS — never expose this client to the browser.
 */
export function createServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY environment variables."
    );
  }

  return createClient(url, secretKey, {
    auth: {
      persistSession: false,
    },
  });
}
