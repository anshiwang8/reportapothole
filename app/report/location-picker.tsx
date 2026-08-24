"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const TORONTO_CENTER: [number, number] = [-79.3832, 43.6532];
const DEFAULT_ZOOM = 10;
const PLACED_ZOOM = 15;

// Bounding box roughly covering the Toronto/GTA area, used to bias forward
// geocoding results toward local intersections. This is a placeholder until
// the app supports reporting in other municipalities.
const GTA_BBOX: [number, number, number, number] = [-79.85, 43.4, -78.9, 44.05];

// Originally calibrated against a bare "Street A and Street B" query (no
// city/province/country context): 8 real GTA intersections scored
// 0.4556-0.5344, fabricated-but-plausible street names scored 0.26-0.43, and
// total gibberish returned zero features. 0.45 sat in the gap between those
// two bands.
//
// After appending city/province/country text to the query (see the query
// construction in handleFindIntersection below) and adding country=ca, real
// intersections now score much higher (0.64-0.89) -- 0.45 still accepts all
// of them, with
// more headroom than before. However the same change means gibberish input
// can ALSO score high: "asdf and zxcv, Toronto, Ontario, Canada" scored
// 0.93, above 7 of the 8 real intersections, because the always-matching
// city/province/country suffix now dominates the relevance score. No single
// threshold can both accept the real range (0.64-0.89) and reject that
// gibberish case (0.93) -- raising the threshold to exclude 0.93 would also
// exclude every real intersection. This is a known gap: relevance alone is
// not a reliable nonsense filter for this query shape. Left at 0.45
// (unchanged) since no other value actually fixes it; the "couldn't find"
// path still reliably catches queries that return zero features.
const RELEVANCE_THRESHOLD = 0.45;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

interface City {
  id: string;
  name: string;
  province: string;
  provinceCode: string;
}

// Exactly one entry for the current MVP (Toronto only), but structured as a
// list so more cities can be added later without changing the field itself.
const CITIES: City[] = [{ id: "toronto", name: "Toronto", province: "Ontario", provinceCode: "ON" }];
const DEFAULT_CITY = CITIES[0];

// Relevance alone can't reject nonsense once city/province/country text is
// appended to every query (see RELEVANCE_THRESHOLD's comment) -- the
// appended text always matches, so gibberish street input can still score
// higher than real intersections. This is a second, independent gate: the
// geocoded result's own descriptive text must mention at least one of the
// two typed street names, suffix differences aside (so "Yonge St" matches
// a result whose text says "Yonge Street").
const STREET_SUFFIXES = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "boulevard", "blvd",
  "drive", "dr", "lane", "ln", "court", "ct", "place", "pl", "way",
  "circle", "cir", "crescent", "cres", "terrace", "terr", "parkway",
  "pkwy", "highway", "hwy", "trail", "square", "sq",
]);

// Direction words/abbreviations normalized to a common form, so e.g. "Queen
// Street West" and "Queen St W" produce the same token sequence. Scoped to
// direction words only -- not general fuzzy matching or spelling
// correction, which would reopen the false-accept problem from the earlier
// diagnostic pass (relevance + this gate both need to stay strict).
const DIRECTION_ALIASES: Record<string, string> = {
  w: "west",
  west: "west",
  e: "east",
  east: "east",
  n: "north",
  north: "north",
  s: "south",
  south: "south",
};

function normalizeStreetName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !STREET_SUFFIXES.has(word))
    .map((word) => DIRECTION_ALIASES[word] ?? word)
    .join(" ");
}

function resultMentionsTypedStreet(resultText: string, street1: string, street2: string): boolean {
  const normalizedResult = normalizeStreetName(resultText);
  const normalized1 = normalizeStreetName(street1);
  const normalized2 = normalizeStreetName(street2);
  return (
    (normalized1 !== "" && normalizedResult.includes(normalized1)) ||
    (normalized2 !== "" && normalizedResult.includes(normalized2))
  );
}

interface LocationPickerProps {
  coordinates: Coordinates | null;
  onChange: (coordinates: Coordinates) => void;
}

interface GeocodeState {
  status: "idle" | "loading" | "error" | "approximate";
  message: string | null;
}

interface GeolocationState {
  status: "idle" | "loading" | "error";
  message: string | null;
}

export default function LocationPicker({ coordinates, onChange }: LocationPickerProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const onChangeRef = useRef(onChange);

  const [intersectionInput, setIntersectionInput] = useState("");
  const [cityId, setCityId] = useState<string>(DEFAULT_CITY.id);
  const [cityQuery, setCityQuery] = useState<string>(DEFAULT_CITY.name);
  const selectedCity = CITIES.find((city) => city.id === cityId) ?? DEFAULT_CITY;
  const [geocodeState, setGeocodeState] = useState<GeocodeState>({
    status: "idle",
    message: null,
  });
  const [geolocationState, setGeolocationState] = useState<GeolocationState>({
    status: "idle",
    message: null,
  });

  function placeMarker(map: mapboxgl.Map, position: Coordinates) {
    if (markerRef.current) {
      markerRef.current.setLngLat([position.longitude, position.latitude]);
    } else {
      const marker = new mapboxgl.Marker({ draggable: true })
        .setLngLat([position.longitude, position.latitude])
        .addTo(map);

      marker.on("dragend", () => {
        const lngLat = marker.getLngLat();
        setGeocodeState((prev) =>
          prev.status === "approximate" ? { status: "idle", message: null } : prev
        );
        onChangeRef.current({ latitude: lngLat.lat, longitude: lngLat.lng });
      });

      markerRef.current = marker;
    }
  }

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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

    map.on("click", (event) => {
      const position: Coordinates = {
        latitude: event.lngLat.lat,
        longitude: event.lngLat.lng,
      };
      placeMarker(map, position);
      setGeocodeState((prev) =>
        prev.status === "approximate" ? { status: "idle", message: null } : prev
      );
      onChangeRef.current(position);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Keep the marker in sync if coordinates are set externally (e.g. geocode
  // or geolocation results), without re-placing it on every drag we already
  // reported ourselves.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !coordinates) {
      return;
    }

    const existing = markerRef.current?.getLngLat();
    const alreadyThere =
      existing &&
      Math.abs(existing.lat - coordinates.latitude) < 1e-9 &&
      Math.abs(existing.lng - coordinates.longitude) < 1e-9;

    if (alreadyThere) {
      return;
    }

    placeMarker(map, coordinates);
    map.flyTo({ center: [coordinates.longitude, coordinates.latitude], zoom: PLACED_ZOOM });
  }, [coordinates]);

  async function handleFindIntersection() {
    const parts = intersectionInput.split(",").map((part) => part.trim());
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      setGeocodeState({
        status: "error",
        message: "Enter two street names separated by a comma, e.g. Finch Ave, Woodbine Ave.",
      });
      return;
    }

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      setGeocodeState({ status: "error", message: "Map is not configured." });
      return;
    }

    setGeocodeState({ status: "loading", message: null });

    try {
      // Mapbox's intersection search format: two street names joined by
      // "and", with `types=address` to enable intersection matching --
      // https://docs.mapbox.com/api/search/geocoding-v5/#intersection-search
      // In practice Mapbox rarely has intersection-level data for the GTA,
      // so a genuine `properties.accuracy === "intersection"` match is rare;
      // acceptance is gated on relevance instead (see RELEVANCE_THRESHOLD),
      // and accuracy is only used below to decide the success message.
      //
      // The selected city's name + province (full name, not the "ON" code
      // -- both scored equivalently on real intersections in testing, but
      // the full name more reliably returned zero features for one
      // fabricated-street test case instead of a low-confidence false
      // match) + "Canada" are appended so the geocoder has enough context to
      // disambiguate same-named streets in different GTA municipalities --
      // without this, "Finch Avenue and Bathurst Street" could resolve to
      // Pickering's Finch Avenue instead of Toronto's.
      const query = `${parts[0]} and ${parts[1]}, ${selectedCity.name}, ${selectedCity.province}, Canada`;
      const url = new URL(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
      );
      url.searchParams.set("access_token", token);
      url.searchParams.set("types", "address");
      url.searchParams.set("bbox", GTA_BBOX.join(","));
      url.searchParams.set("country", "ca");
      url.searchParams.set("limit", "1");

      const response = await fetch(url);
      if (!response.ok) {
        setGeocodeState({
          status: "error",
          message: "Couldn't find that intersection — try adjusting the pin on the map or use your location instead.",
        });
        return;
      }

      const data = await response.json();
      const feature = data?.features?.[0];
      const relevance = typeof feature?.relevance === "number" ? feature.relevance : 0;

      if (!feature || relevance < RELEVANCE_THRESHOLD) {
        setGeocodeState({
          status: "error",
          message: "Couldn't find that intersection — try adjusting the pin on the map or use your location instead.",
        });
        return;
      }

      if (!resultMentionsTypedStreet(feature.place_name ?? "", parts[0], parts[1])) {
        setGeocodeState({
          status: "error",
          message: "Couldn't find that intersection — try adjusting the pin on the map or use your location instead.",
        });
        return;
      }

      const isExactIntersection = feature.properties?.accuracy === "intersection";
      const [longitude, latitude] = feature.center as [number, number];
      setGeocodeState(
        isExactIntersection
          ? { status: "idle", message: null }
          : {
              status: "approximate",
              message: "Approximate location — adjust the pin if needed.",
            }
      );
      onChangeRef.current({ latitude, longitude });
    } catch {
      setGeocodeState({
        status: "error",
        message: "Couldn't find that intersection — try adjusting the pin on the map or use your location instead.",
      });
    }
  }

  function handleUseCurrentLocation() {
    if (!("geolocation" in navigator)) {
      setGeolocationState({
        status: "error",
        message: "Your browser doesn't support location access.",
      });
      return;
    }

    setGeolocationState({ status: "loading", message: null });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeolocationState({ status: "idle", message: null });
        setGeocodeState((prev) =>
          prev.status === "approximate" ? { status: "idle", message: null } : prev
        );
        onChangeRef.current({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? "Location permission denied. You can still find an intersection or tap the map."
            : error.code === error.TIMEOUT
              ? "Timed out getting your location. You can still find an intersection or tap the map."
              : "Couldn't get your location. You can still find an intersection or tap the map.";
        setGeolocationState({ status: "error", message });
      },
      { timeout: 10000 }
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        City
        <input
          type="text"
          list="city-options"
          value={cityQuery}
          onChange={(event) => {
            const value = event.target.value;
            setCityQuery(value);
            const match = CITIES.find(
              (city) => city.name.toLowerCase() === value.trim().toLowerCase()
            );
            if (match) {
              setCityId(match.id);
            }
          }}
          className="border p-2"
        />
        <datalist id="city-options">
          {CITIES.map((city) => (
            <option key={city.id} value={city.name} />
          ))}
        </datalist>
      </label>

      <label className="flex flex-col gap-1">
        Intersection
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Finch Ave, Woodbine Ave"
            value={intersectionInput}
            onChange={(event) => setIntersectionInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleFindIntersection();
              }
            }}
            className="flex-1 border p-2"
          />
          <button
            type="button"
            onClick={() => void handleFindIntersection()}
            disabled={geocodeState.status === "loading"}
            className="border p-2"
          >
            {geocodeState.status === "loading" ? "Finding..." : "Find"}
          </button>
        </div>
      </label>
      {geocodeState.status === "error" && geocodeState.message && (
        <p className="text-sm text-red-600">{geocodeState.message}</p>
      )}
      {geocodeState.status === "approximate" && geocodeState.message && (
        <p className="text-sm text-amber-600">{geocodeState.message}</p>
      )}

      <button
        type="button"
        onClick={handleUseCurrentLocation}
        disabled={geolocationState.status === "loading"}
        className="border p-2"
      >
        {geolocationState.status === "loading" ? "Getting location..." : "Use my current location"}
      </button>
      {geolocationState.status === "error" && geolocationState.message && (
        <p className="text-sm text-red-600">{geolocationState.message}</p>
      )}

      <div
        ref={mapContainerRef}
        className="h-72 w-full sm:h-96"
        aria-label="Map for selecting the pothole location"
      />
      <p className="text-sm text-gray-600">
        {coordinates
          ? `Pin at ${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)}. Drag it or tap the map to adjust.`
          : "Find an intersection, use your location, or tap the map to place a pin."}
      </p>
    </div>
  );
}
