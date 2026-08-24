"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const TORONTO_CENTER: [number, number] = [-79.3832, 43.6532];
const DEFAULT_ZOOM = 10;
const PLACED_ZOOM = 15;

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

// Exactly one entry for the current MVP (Toronto only), matching the coverage
// of the intersection dataset below. Structured as a list so more cities can
// be added later without changing the field itself.
const CITIES: City[] = [{ id: "toronto", name: "Toronto", province: "Ontario", provinceCode: "ON" }];
const DEFAULT_CITY = CITIES[0];

/**
 * One entry of public/data/toronto-intersections.json, produced by
 * scripts/build-intersections.mjs from City of Toronto Open Data.
 * `label` is the full source description (may include trail/ramp arms);
 * `streets` holds only the searchable street names.
 */
interface Intersection {
  label: string;
  streets: string[];
  lat: number;
  lng: number;
}

interface IndexedIntersection extends Intersection {
  lowerStreets: string[];
}

const INTERSECTIONS_URL = "/data/toronto-intersections.json";

// Below this many characters the result list is too broad to be useful --
// "st" alone matches ~7,000 of the 19,134 entries.
const MIN_QUERY_LENGTH = 3;
const MAX_RESULTS = 25;

// Module-level cache: the dataset is static, so one fetch serves every mount
// of this component for the lifetime of the page.
let cachedDataset: IndexedIntersection[] | null = null;
let inFlightLoad: Promise<IndexedIntersection[]> | null = null;

async function loadIntersections(): Promise<IndexedIntersection[]> {
  if (cachedDataset) {
    return cachedDataset;
  }
  if (!inFlightLoad) {
    inFlightLoad = (async () => {
      try {
        const response = await fetch(INTERSECTIONS_URL);
        if (!response.ok) {
          throw new Error(`Failed to load intersections: HTTP ${response.status}`);
        }
        const raw = (await response.json()) as Intersection[];
        const indexed = raw.map((entry) => ({
          ...entry,
          lowerStreets: entry.streets.map((street) => street.toLowerCase()),
        }));
        cachedDataset = indexed;
        return indexed;
      } catch (error) {
        // Clear so a later mount can retry rather than reusing a failed promise.
        inFlightLoad = null;
        throw error;
      }
    })();
  }
  return inFlightLoad;
}

/**
 * True when every term can be matched to a *distinct* street of this entry,
 * regardless of the order the streets appear in (the source data's ordering
 * is arbitrary). Backtracking search for a system of distinct
 * representatives -- entries have at most a handful of streets, so the
 * search space is trivial.
 *
 * Requiring distinct streets is what stops "yonge, yonge" from matching an
 * entry that merely contains Yonge once.
 */
function matchesAllTerms(lowerStreets: string[], terms: string[]): boolean {
  const used = new Array<boolean>(lowerStreets.length).fill(false);

  function assign(termIndex: number): boolean {
    if (termIndex === terms.length) {
      return true;
    }
    const term = terms[termIndex];
    for (let i = 0; i < lowerStreets.length; i++) {
      if (used[i] || !lowerStreets[i].includes(term)) {
        continue;
      }
      used[i] = true;
      if (assign(termIndex + 1)) {
        return true;
      }
      used[i] = false;
    }
    return false;
  }

  return assign(0);
}

// Prefix matches rank above pure substring matches, so typing "queen" puts
// "Queen St W" above "Lower Queensway Blvd".
function scoreEntry(lowerStreets: string[], terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    score += lowerStreets.some((street) => street.startsWith(term)) ? 2 : 1;
  }
  return score;
}

function parseTerms(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

interface LocationPickerProps {
  coordinates: Coordinates | null;
  onChange: (coordinates: Coordinates) => void;
}

type DatasetStatus = "loading" | "ready" | "error";

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
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [dataset, setDataset] = useState<IndexedIntersection[] | null>(null);
  const [datasetStatus, setDatasetStatus] = useState<DatasetStatus>("loading");
  const [cityId, setCityId] = useState<string>(DEFAULT_CITY.id);
  const [cityQuery, setCityQuery] = useState<string>(DEFAULT_CITY.name);
  const selectedCity = CITIES.find((city) => city.id === cityId) ?? DEFAULT_CITY;
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
        onChangeRef.current({ latitude: lngLat.lat, longitude: lngLat.lng });
      });

      markerRef.current = marker;
    }
  }

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Loaded on mount rather than on first focus: the file is ~2.1 MB (~434 KB
  // gzipped), and starting the fetch when the user focuses the field would
  // put the download squarely in the way of their first keystroke. Fetching
  // in the background overlaps it with reading the page and the map's own
  // tile loading, so results are ready by the time anyone types.
  useEffect(() => {
    let cancelled = false;

    loadIntersections()
      .then((indexed) => {
        if (cancelled) return;
        setDataset(indexed);
        setDatasetStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load the intersections dataset:", error);
        setDatasetStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

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
      onChangeRef.current(position);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Keep the marker in sync if coordinates are set externally (e.g. an
  // intersection selection or geolocation result), without re-placing it on
  // every drag we already reported ourselves.
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

  const terms = useMemo(() => parseTerms(intersectionInput), [intersectionInput]);
  const hasEnoughInput = terms.length > 0 && terms[0].length >= MIN_QUERY_LENGTH;

  const results = useMemo(() => {
    if (!dataset || !hasEnoughInput) {
      return [];
    }
    return dataset
      .filter((entry) => matchesAllTerms(entry.lowerStreets, terms))
      .map((entry) => ({ entry, score: scoreEntry(entry.lowerStreets, terms) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.entry.streets.length - b.entry.streets.length ||
          a.entry.label.localeCompare(b.entry.label)
      )
      .slice(0, MAX_RESULTS)
      .map(({ entry }) => entry);
  }, [dataset, terms, hasEnoughInput]);

  function handleSelectIntersection(entry: IndexedIntersection) {
    setIntersectionInput(entry.label);
    setIsDropdownOpen(false);
    onChangeRef.current({ latitude: entry.lat, longitude: entry.lng });
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

  const showDropdown = isDropdownOpen && hasEnoughInput && datasetStatus === "ready";
  const showNoResults = showDropdown && results.length === 0;

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

      <div className="flex flex-col gap-1">
        <label htmlFor="intersection-input">Intersection</label>
        <div className="relative">
          <input
            id="intersection-input"
            type="text"
            autoComplete="off"
            placeholder="Finch Ave, Woodbine Ave"
            value={intersectionInput}
            onChange={(event) => {
              setIntersectionInput(event.target.value);
              setIsDropdownOpen(true);
            }}
            onFocus={() => setIsDropdownOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setIsDropdownOpen(false);
              }
            }}
            className="w-full border p-2"
          />

          {showDropdown && results.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-10 max-h-64 overflow-y-auto border border-t-0 bg-white">
              {results.map((entry) => (
                <li key={`${entry.label}|${entry.lat}|${entry.lng}`}>
                  <button
                    type="button"
                    // Keep focus on the input so the dropdown isn't torn down
                    // by blur before the click lands.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleSelectIntersection(entry)}
                    className="block w-full px-2 py-2 text-left text-sm hover:bg-gray-100"
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {datasetStatus === "loading" && (
        <p className="text-sm text-gray-600">Loading intersections…</p>
      )}
      {datasetStatus === "error" && (
        <p className="text-sm text-red-600">
          Couldn&apos;t load the intersection list. You can still use your location or tap the
          map to place a pin.
        </p>
      )}
      {showNoResults && (
        <p className="text-sm text-red-600">
          No matching intersections in {selectedCity.name} — try adjusting the pin on the map or
          use your location instead.
        </p>
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
