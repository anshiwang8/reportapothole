"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import LocationPicker, { type Coordinates } from "./location-picker";

const SEVERITY_OPTIONS = ["low", "medium", "high"] as const;

interface ReportResponse {
  public_id: string;
}

export default function ReportPage() {
  const router = useRouter();
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!coordinates) {
      return;
    }
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
          description: description === "" ? undefined : description,
          severity: severity === "" ? undefined : severity,
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
