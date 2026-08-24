import { randomUUID } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";
import { getClientIp, hashIp, isRateLimited, recordRateLimitEvent } from "@/lib/rate-limit";

const PHOTO_BUCKET = "report-photos";

// Matches the bucket's own allowed_mime_types (supabase/migrations/0003_photo_storage.sql).
// HEIC/HEIF are included because iOS Safari's HEIC-to-JPEG conversion on
// file-input upload is inconsistent across versions (confirmed via
// research, not assumed) -- rejecting them here would break real iPhone
// photo uploads for some users.
const ALLOWED_PHOTO_MIME_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export async function POST(request: Request) {
  const supabase = createServerClient();
  const ipHash = hashIp(getClientIp(request));

  // Same shared rate-limit budget as POST /api/reports (see lib/rate-limit.ts)
  // -- this is a second public write-adjacent surface and must not be left
  // unprotected. Distinct error message so the client can tell which action
  // was rate-limited, even though the underlying counting is shared.
  if (await isRateLimited(supabase, ipHash)) {
    return Response.json(
      { error: "Too many photo uploads attempted recently. Please try again later." },
      { status: 429 }
    );
  }
  await recordRateLimitEvent(supabase, ipHash);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof body !== "object" || body === null) {
    return Response.json(
      { error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  const { contentType } = body as Record<string, unknown>;

  if (typeof contentType !== "string" || !(contentType in ALLOWED_PHOTO_MIME_TYPES)) {
    return Response.json(
      {
        error: `contentType must be one of: ${Object.keys(ALLOWED_PHOTO_MIME_TYPES).join(", ")}.`,
      },
      { status: 400 }
    );
  }

  // Never accept a client-supplied filename or path -- always generate a
  // random, unguessable one server-side.
  const extension = ALLOWED_PHOTO_MIME_TYPES[contentType];
  const path = `reports/${randomUUID()}.${extension}`;

  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUploadUrl(path);

  if (error || !data) {
    console.error("Failed to create signed upload URL:", error);
    return Response.json(
      { error: "Failed to prepare photo upload. Please try again." },
      { status: 500 }
    );
  }

  return Response.json(
    {
      signedUrl: data.signedUrl,
      token: data.token,
      path: data.path,
    },
    { status: 200 }
  );
}
