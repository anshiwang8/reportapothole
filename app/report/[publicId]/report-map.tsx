"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const MARKER_ZOOM = 15;

interface ReportMapProps {
  latitude: number;
  longitude: number;
}

// Read-only counterpart to the interactive map in app/report/location-picker.tsx:
// same map setup (style, container height convention, cleanup on unmount),
// but just a fixed, non-draggable marker -- no click-to-move, no dragging.
export default function ReportMap({ latitude, longitude }: ReportMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

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
      center: [longitude, latitude],
      zoom: MARKER_ZOOM,
    });

    map.addControl(new mapboxgl.NavigationControl(), "top-right");
    new mapboxgl.Marker().setLngLat([longitude, latitude]).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [latitude, longitude]);

  return (
    <div
      ref={mapContainerRef}
      className="h-72 w-full sm:h-96"
      aria-label="Map showing the reported pothole location"
    />
  );
}
