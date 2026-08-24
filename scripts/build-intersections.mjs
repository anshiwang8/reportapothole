/**
 * One-time data pipeline: raw City of Toronto Centreline Intersection
 * GeoJSON  ->  small static JSON asset for the client-side typeahead.
 *
 * Run manually (NOT part of the Next.js build):
 *   node scripts/build-intersections.mjs
 *
 * Input :  datasets/Centreline Intersection - 4326.geojson   (gitignored, ~33.9 MB)
 * Output:  public/data/toronto-intersections.json            (committed, compact)
 *
 * ---------------------------------------------------------------------------
 * SOURCE & ATTRIBUTION
 *   City of Toronto Open Data — "Intersection File - City of Toronto"
 *   https://open.toronto.ca/dataset/intersection-file-city-of-toronto/
 *   Contains information licensed under the Open Government Licence – Toronto.
 * ---------------------------------------------------------------------------
 *
 * Written as .mjs rather than .ts so it runs under plain `node` with no
 * transpiler: adding tsx/ts-node just for a one-time script would mean a new
 * dependency, and the app runtime never imports this file.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(REPO_ROOT, "datasets", "Centreline Intersection - 4326.geojson");
const OUTPUT = join(REPO_ROOT, "public", "data", "toronto-intersections.json");

/**
 * ELEVATION_FEATURE_CODE_DESC classifies the intersection NODE, not the
 * streets. Derived from the data (counts are node totals, pre-arity-filter):
 *
 *   Minor       20640  real street-to-street intersection      <- KEEP
 *   Major         293  real major-arterial intersection        <- KEEP
 *   Pedatraian   8096  trail / pedestrian crossing  (sic: source-data typo)
 *   Pseudo       5970  overpass/underpass -- roads cross but do NOT connect
 *   Cul de sac   5959  dead end, not a through intersection
 *   Laneway      3854  laneway node, positionally named
 *   Expressway    539  highway ramp interchange
 *   Utility       534  hydro corridor crossing ("Hepc")
 *   Railway       176  rail crossing
 *   River          93  watercourse crossing
 *   others        ~70  "No Intersection" / "Error No Domain Descrption" / etc.
 *
 * Only Major and Minor are places a person can stand and report a pothole.
 * Pseudo is the important exclusion: an overpass is not a reachable corner.
 */
const ROAD_NODE_TYPES = new Set(["Major", "Minor"]);

/**
 * Fragment-level noise. Even inside Major/Minor nodes, an individual arm of
 * the intersection can be a ramp, trail, laneway, rail spur, creek, or hydro
 * corridor. These are excluded from the searchable `streets` list (they are
 * not things a person types to locate a pothole), while remaining visible in
 * the display `label`, which stays faithful to the source description.
 */
const NOISE_FRAGMENT_PATTERNS = [
  /^Ln\b/i, // positionally-named laneway, e.g. "Ln N Dundas W Acorn"
  /\bramp\b/i, // "427 N Rexdale E Ramp"
  /\bTrl$/i, // "Martin Goodman Trl"
  /\bsubway\b/i, // "Yonge-University Subway"
  /\bC ?[NP] ?R\b/i, // "C N R", "C P R Spur"
  /\b(creek|river|trib)\b/i, // watercourses
  /^hepc$/i, // hydro corridor
  /^none$/i, // literal "None" placeholder in source
  /^(highway|hwy)\b/i, // "Highway 427"
  /^\d{3}\b/, // bare route numbers, e.g. "427 C S Qew X W Ramp"
  /\bQEW\b/i,
  /\b(XWY|Expy)\b/i, // "Gardiner XWY"
  /^Gardiner\b/i,
  /^DVP\b/i,
];

const isNoiseFragment = (name) => NOISE_FRAGMENT_PATTERNS.some((re) => re.test(name));

const splitFragments = (desc) =>
  (desc ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");

const round6 = (n) => Number(n.toFixed(6));

// ---------------------------------------------------------------------------

console.log("Reading", INPUT);
const raw = JSON.parse(readFileSync(INPUT, "utf8"));
const features = raw.features;
console.log(`  total features: ${features.length}`);

const stats = {
  total: features.length,
  droppedNodeType: 0,
  droppedArity1: 0,
  droppedSelfReferential: 0,
  droppedInsufficientRealStreets: 0,
  droppedDuplicate: 0,
  kept: 0,
};

const seen = new Set();
const out = [];

for (const f of features) {
  const props = f.properties;

  // 1. real street-level intersection nodes only
  if (!ROAD_NODE_TYPES.has(props.ELEVATION_FEATURE_CODE_DESC)) {
    stats.droppedNodeType++;
    continue;
  }

  const fragments = splitFragments(props.INTERSECTION_DESC);

  // 2. single-street entries are trail nodes / dead ends, not intersections
  if (fragments.length < 2) {
    stats.droppedArity1++;
    continue;
  }

  // 3. self-referential, e.g. "Highway 427 / Highway 427"
  if (new Set(fragments.map((s) => s.toLowerCase())).size === 1) {
    stats.droppedSelfReferential++;
    continue;
  }

  // 4. need >=2 DISTINCT real street names to be a typeable destination.
  //    This is what removes pure ramp junctions like
  //    "Highway 27 N / 27 N Dixon E Ramp" while keeping genuine street
  //    intersections that merely happen to have a ramp or trail arm.
  const streets = [];
  const seenStreet = new Set();
  for (const frag of fragments) {
    if (isNoiseFragment(frag)) continue;
    const key = frag.toLowerCase();
    if (seenStreet.has(key)) continue;
    seenStreet.add(key);
    streets.push(frag);
  }
  if (streets.length < 2) {
    stats.droppedInsufficientRealStreets++;
    continue;
  }

  const [lng, lat] = f.geometry.coordinates[0];
  const label = props.INTERSECTION_DESC;

  // 5. de-duplicate multi-level nodes that share a label and position
  const dedupeKey = `${label}|${round6(lat)}|${round6(lng)}`;
  if (seen.has(dedupeKey)) {
    stats.droppedDuplicate++;
    continue;
  }
  seen.add(dedupeKey);

  out.push({ label, streets, lat: round6(lat), lng: round6(lng) });
}

// Deterministic order so re-running the pipeline produces an identical file.
out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.lat - b.lat));
stats.kept = out.length;

mkdirSync(dirname(OUTPUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUTPUT, json);

const bytes = Buffer.byteLength(json);
const gzipped = gzipSync(json).length;

console.log("\n--- filter results ---");
console.log(`  total features                    ${String(stats.total).padStart(7)}`);
console.log(`  - not Major/Minor node type       ${String(-stats.droppedNodeType).padStart(7)}`);
console.log(`  - single-street (arity 1)         ${String(-stats.droppedArity1).padStart(7)}`);
console.log(`  - self-referential                ${String(-stats.droppedSelfReferential).padStart(7)}`);
console.log(`  - <2 distinct real streets        ${String(-stats.droppedInsufficientRealStreets).padStart(7)}`);
console.log(`  - duplicate label+position        ${String(-stats.droppedDuplicate).padStart(7)}`);
console.log(`  = kept                            ${String(stats.kept).padStart(7)}`);
console.log("\n--- output ---");
console.log(`  ${OUTPUT}`);
console.log(`  ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  ${gzipped} bytes gzipped (${(gzipped / 1024).toFixed(0)} KB over the wire)`);
console.log(`  distinct street names: ${new Set(out.flatMap((e) => e.streets)).size}`);
