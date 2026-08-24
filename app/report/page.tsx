"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/client";
import LocationPicker, { type Coordinates } from "./location-picker";

const SEVERITY_OPTIONS = ["low", "medium", "high"] as const;

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

export default function ReportPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handlePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setPhotoError(null);

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setPhotoError("Please select an image file.");
      event.target.value = "";
      return;
    }

    if (file.size > MAX_PHOTO_PRECHECK_BYTES) {
      setPhotoError("That photo is too large. Please choose a smaller one.");
      event.target.value = "";
      return;
    }

    setPhotoFile(file);
    setPhotoPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return URL.createObjectURL(file);
    });
  }

  function handleRemovePhoto() {
    setPhotoFile(null);
    setPhotoPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return null;
    });
    setPhotoError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!coordinates) {
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      let photoPath: string | undefined;

      if (photoFile) {
        const uploadUrlResponse = await fetch("/api/photos/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentType: photoFile.type }),
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
          .uploadToSignedUrl(path, token, photoFile);

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
      <h1 className="text-2xl font-bold">Report a Pothole</h1>
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3">
        <LocationPicker coordinates={coordinates} onChange={setCoordinates} />
        <label className="flex flex-col gap-1">
          Photo (optional)
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            className="border p-2"
          />
        </label>
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
        <button type="submit" disabled={isSubmitting || !coordinates} className="border p-2">
          {isSubmitting ? "Submitting..." : "Submit report"}
        </button>
      </form>
      {error && <p className="text-red-600">{error}</p>}
    </main>
  );
}
