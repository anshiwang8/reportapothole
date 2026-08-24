"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import LocationPicker, { type Coordinates } from "./location-picker";

const SEVERITY_OPTIONS = ["low", "medium", "high"] as const;

interface ReportResponse {
  public_id: string;
  latitude: number;
  longitude: number;
  address: string | null;
  municipality: string | null;
  province: string | null;
  status: string;
}

export default function ReportPage() {
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!coordinates) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    setResult(null);

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
        return;
      }

      setResult(payload as ReportResponse);
    } catch {
      setError("Network error. Please try again.");
    } finally {
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
      {result && (
        <p>
          Report submitted. Public ID: <strong>{result.public_id}</strong>
          {" — "}
          <Link href={`/report/${result.public_id}`} className="underline">
            View your report
          </Link>
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </main>
  );
}
