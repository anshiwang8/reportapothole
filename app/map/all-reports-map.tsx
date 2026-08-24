"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

// Same Toronto default view as app/report/location-picker.tsx.
const TORONTO_CENTER: [number, number] = [-79.3832, 43.6532];
const DEFAULT_ZOOM = 10;

const RESOLVED_COLOR = "#16a34a";
const OPEN_COLOR = "#dc2626";

export interface MapReport {
  public_id: string;
  latitude: number;
  longitude: number;
  status: string;
}

interface AllReportsMapProps {
  reports: MapReport[];
}

// Multi-marker counterpart to app/report/[publicId]/report-map.tsx: same map
// setup (style, container height convention, cleanup on unmount), but one
// marker per report, color-coded by status, that navigates to that report's
// page on click.
export default function AllReportsMap({ reports }: AllReportsMapProps) {
  const router = useRouter();
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  // Read from a ref inside the marker click handler so the markers effect
  // below doesn't need `router` in its own dependency array.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      console.error("NEXT_PUBLIC_MAPBOX_TOKEN is not set; map cannot be initialized.");
      return;
    }
    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: TORONTO_CENTER,
      zoom: DEFAULT_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Rebuilds all markers whenever the report list changes (in practice just
  // once, since this page fetches once on the server). Fine at current
  // report volumes; re-creating hundreds+ of DOM marker elements per render
  // would need to become an incremental diff, or a Mapbox GeoJSON/clustering
  // layer, if the dataset grows much larger.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const markers = reports.map((report) => {
      const color = report.status === "resolved" ? RESOLVED_COLOR : OPEN_COLOR;
      const marker = new mapboxgl.Marker({ color })
        .setLngLat([report.longitude, report.latitude])
        .addTo(map);

      const element = marker.getElement();
      element.style.cursor = "pointer";
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", `View report ${report.public_id}`);
      element.addEventListener("click", () => {
        routerRef.current.push(`/report/${report.public_id}`);
      });

      return marker;
    });

    markersRef.current = markers;

    return () => {
      markers.forEach((marker) => marker.remove());
      markersRef.current = [];
    };
  }, [reports]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={mapContainerRef}
        className="h-72 w-full sm:h-96"
        aria-label="Map showing all reported potholes"
      />
      {reports.length === 0 && <p className="text-sm text-gray-600">No reports yet.</p>}
    </div>
  );
}
