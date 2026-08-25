// Strips EXIF metadata (GPS, timestamp, device info) from a user-selected
// photo before upload. Photo bytes go straight from the browser to Supabase
// Storage via a signed URL (see app/api/photos/upload-url/route.ts) and never
// pass through a Vercel function, so there is no server-side place to do
// this -- it has to happen here, before the upload call.
//
// Mechanism: redraw the decoded image onto a <canvas> and re-export it.
// Canvas output carries no EXIF segment at all -- the encoders canvas uses
// don't preserve one -- so this isn't a targeted strip of specific tags, the
// entire segment is gone. The unavoidable side effect is a recompression
// pass (pixel dimensions are preserved exactly; this is not a resize).

// Recompression quality for the JPEG re-encode. Same spirit as
// DUPLICATE_RADIUS_METERS in app/api/reports/route.ts: a reasonable,
// untuned default, not derived from measuring output size/quality on real
// photos. Revisit if uploaded photos come out visibly over-compressed.
export const JPEG_EXPORT_QUALITY = 0.92;

export class PhotoProcessingError extends Error {}

export interface ProcessedPhoto {
  blob: Blob;
  contentType: "image/jpeg" | "image/png" | "image/webp";
}

// Canvas has no HEIC/HEIF encoder -- no browser exposes one to
// canvas.toBlob (confirmed via research, not assumed: HEIC/HEIF licensing
// means browsers that can decode it, Apple platforms, still can't encode
// it). So a HEIC/HEIF source is re-encoded as JPEG instead of its original
// type; that's fine, image/jpeg is already an allowed contentType for
// POST /api/photos/upload-url. Browsers that can't even decode HEIC (most
// non-Apple browsers/platforms) fail at the createImageBitmap step below
// and are rejected the same way any other undecodable file is -- expected,
// not a bug: those browsers already couldn't preview a HEIC photo before
// this feature existed.
function outputContentType(sourceType: string): ProcessedPhoto["contentType"] {
  if (sourceType === "image/png") return "image/png";
  if (sourceType === "image/webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Decodes `file`, redraws it onto a canvas at its original pixel dimensions,
 * and exports a fresh blob with no EXIF segment. Orientation-safe: passing
 * `imageOrientation: "from-image"` makes createImageBitmap bake the EXIF
 * orientation tag into the decoded pixels, so the (now EXIF-less) output
 * still displays right-side-up. Explicit rather than relying on the
 * platform default, since that default changed over the API's history.
 *
 * Never falls back to the original file on failure -- that would silently
 * defeat the point of this function. Callers must treat a thrown
 * PhotoProcessingError as "reject this photo," not "use the original."
 */
export async function stripPhotoMetadata(file: File): Promise<ProcessedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoProcessingError("Could not decode the selected image.");
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new PhotoProcessingError("Canvas 2D context is unavailable.");
    }

    context.drawImage(bitmap, 0, 0);

    const contentType = outputContentType(file.type);
    const quality = contentType === "image/jpeg" ? JPEG_EXPORT_QUALITY : undefined;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, contentType, quality);
    });

    if (!blob) {
      throw new PhotoProcessingError("Exporting the processed image failed.");
    }

    return { blob, contentType };
  } finally {
    bitmap.close();
  }
}
