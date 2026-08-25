"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import { stripPhotoMetadata, type ProcessedPhoto } from "@/lib/photo-processing";
import LocationPicker, { type Coordinates } from "./location-picker";

const SEVERITY_OPTIONS = ["low", "medium", "high"] as const;

// Client-side-only format check -- the server (app/api/reports/route.ts)
// deliberately does not validate format, only type/length, per the
// project's requirements for this optional field.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ReportResponse {
  public_id: string;
}

interface UploadUrlResponse {
  signedUrl: string;
  token: string;
  path: string;
}

// Generous pre-check to catch obviously-oversized files (e.g. an
// accidentally-selected video) without a network call. The bucket's own
// 10MB file_size_limit (supabase/migrations/0003_photo_storage.sql) is the
// authoritative limit -- a file between 10-15MB passes this check but can
// still be rejected at the actual upload step, surfacing as the normal
// "photo failed to upload" error below. That's expected, not a bug.
const MAX_PHOTO_PRECHECK_BYTES = 15 * 1024 * 1024;

// The bucket's own file_size_limit (supabase/migrations/0003_photo_storage.sql)
// -- this is what actually matters for the processed photo, re-checked here
// because canvas re-encoding (see lib/photo-processing.ts) changes the byte
// size and can push a file that passed the raw pre-check above over the
// real limit.
const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;

export default function ReportPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Guards against a stale processing result (from a photo the user has
  // since removed or replaced) landing after a newer selection -- bumped on
  // every new selection and on remove.
  const photoSelectionIdRef = useRef(0);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("");
  const [reporterEmail, setReporterEmail] = useState("");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const inputEl = event.target;
    const file = inputEl.files?.[0] ?? null;
    setPhotoError(null);

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setPhotoError("Please select an image file.");
      inputEl.value = "";
      return;
    }

    if (file.size > MAX_PHOTO_PRECHECK_BYTES) {
      setPhotoError("That photo is too large. Please choose a smaller one.");
      inputEl.value = "";
      return;
    }

    const selectionId = ++photoSelectionIdRef.current;
    setIsProcessingPhoto(true);

    // Redraw onto a canvas and re-export -- this is what actually strips
    // EXIF (GPS, timestamp, device info); see lib/photo-processing.ts. No
    // fallback to the raw file on failure: that would silently defeat the
    // point of this step.
    let processed: ProcessedPhoto;
    try {
      processed = await stripPhotoMetadata(file);
    } catch {
      if (selectionId === photoSelectionIdRef.current) {
        setPhotoError("That photo couldn't be processed. Please try a different one.");
        setIsProcessingPhoto(false);
        inputEl.value = "";
      }
      return;
    }

    // A newer selection (or a remove) has already superseded this one.
    if (selectionId !== photoSelectionIdRef.current) {
      return;
    }

    if (processed.blob.size > MAX_PHOTO_UPLOAD_BYTES) {
      setPhotoError("That photo is too large after processing. Please choose a smaller one.");
      setIsProcessingPhoto(false);
      inputEl.value = "";
      return;
    }

    setPhotoBlob(processed.blob);
    setPhotoPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return URL.createObjectURL(processed.blob);
    });
    setIsProcessingPhoto(false);
  }

  function handleRemovePhoto() {
    photoSelectionIdRef.current += 1;
    setPhotoBlob(null);
    setPhotoPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return null;
    });
    setPhotoError(null);
    setIsProcessingPhoto(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!coordinates) {
      return;
    }
    if (reporterEmail !== "" && !EMAIL_PATTERN.test(reporterEmail)) {
      setError("Please enter a valid email address, or leave it blank.");
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      let photoPath: string | undefined;

      if (photoBlob) {
        const uploadUrlResponse = await fetch("/api/photos/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: photoBlob.type }),
        });
        const uploadUrlPayload = await uploadUrlResponse.json();

        if (!uploadUrlResponse.ok) {
          setError(
            uploadUrlPayload.error ??
              "The photo failed to upload. You can try again or remove the photo and submit without it."
          );
          setIsSubmitting(false);
          return;
        }

        // uploadToSignedUrl only needs path + token; signedUrl is returned by
        // the API for completeness (matching what the SDK method returns).
        const { token, path } = uploadUrlPayload as UploadUrlResponse;

        const browserClient = createBrowserClient();
        const { error: uploadError } = await browserClient.storage
          .from("report-photos")
          .uploadToSignedUrl(path, token, photoBlob);

        if (uploadError) {
          setError(
            "The photo failed to upload. You can try again or remove the photo and submit without it."
          );
          setIsSubmitting(false);
          return;
        }

        photoPath = path;
      }

      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          description: description === "" ? undefined : description,
          severity: severity === "" ? undefined : severity,
          photoPath,
          reporterEmail: reporterEmail === "" ? undefined : reporterEmail,
        }),
      });

      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Something went wrong.");
        setIsSubmitting(false);
        return;
      }

      // Deliberately not resetting isSubmitting here: the form is navigating
      // away, so leaving the button disabled avoids a flash of an
      // interactive-looking form between the response and the navigation.
      router.replace(`/report/${(payload as ReportResponse).public_id}?created=1`);
    } catch {
      setError("Network error. Please try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Report a pothole</h1>
      <p className="text-sm text-gray-600">by anshiwang.com</p>
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <LocationPicker coordinates={coordinates} onChange={setCoordinates} />
        <label className="flex flex-col gap-1">
          Photo (optional)
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            disabled={isProcessingPhoto}
            className="border p-2"
          />
        </label>
        {isProcessingPhoto && <p className="text-sm text-gray-600">Processing photo...</p>}
        {photoError && <p className="text-sm text-red-600">{photoError}</p>}
        {photoPreviewUrl && (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview, not a next/image-eligible remote asset */}
            <img
              src={photoPreviewUrl}
              alt="Selected photo preview"
              className="h-24 w-24 border object-cover"
            />
            <button type="button" onClick={handleRemovePhoto} className="border p-2">
              Remove photo
            </button>
          </div>
        )}
        <label className="flex flex-col gap-1">
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={1000}
            className="border p-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          Severity
          <select
            value={severity}
            onChange={(event) => setSeverity(event.target.value)}
            className="border p-2"
          >
            <option value="">(none)</option>
            {SEVERITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Email (optional)
          <input
            type="email"
            value={reporterEmail}
            onChange={(event) => setReporterEmail(event.target.value)}
            placeholder="you@example.com"
            className="border p-2"
          />
          <span className="text-xs text-gray-500">
            Optional. The City may use this to follow up on your report.
          </span>
        </label>
        <button
          type="submit"
          disabled={isSubmitting || isProcessingPhoto || !coordinates}
          className="border p-2"
        >
          {isSubmitting ? "Submitting..." : "Submit report"}
        </button>
      </form>
      {error && <p className="text-red-600">{error}</p>}
    </main>
  );
}
