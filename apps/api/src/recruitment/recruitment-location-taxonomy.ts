/** Sprint 7.16 (Phase 5) — geographic normalization for candidate location fields. A single, centrally
 * editable data table (not scattered special-cases through the parsing/filtering logic) per the sprint's
 * "Use a configurable geographic region taxonomy rather than hardcoded assumptions" requirement. Extend
 * the tables below to add coverage; nothing elsewhere in the codebase needs to change. */

/** City-name aliases -> canonical spelling. Lookup is case-insensitive; keys are lowercase. */
const CITY_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  bengaluru: "Bengaluru",
  bombay: "Mumbai",
  mumbai: "Mumbai",
  calcutta: "Kolkata",
  kolkata: "Kolkata",
  madras: "Chennai",
  chennai: "Chennai",
  gurgaon: "Gurugram",
  gurugram: "Gurugram",
  "greater noida": "Greater Noida",
  noida: "Noida",
  "new delhi": "Delhi",
  delhi: "Delhi",
  ghaziabad: "Ghaziabad",
  faridabad: "Faridabad",
  pune: "Pune",
  poona: "Pune",
  hyderabad: "Hyderabad",
  secunderabad: "Hyderabad",
  trivandrum: "Thiruvananthapuram",
  thiruvananthapuram: "Thiruvananthapuram",
  cochin: "Kochi",
  kochi: "Kochi",
  bangaluru: "Bengaluru"
};

/** Canonical city -> region group. A region groups several cities a recruiter commonly searches as one
 * unit (e.g. "Show me Delhi NCR candidates" should match Noida, Gurugram, Ghaziabad, Faridabad and Delhi
 * itself, not just the literal string "Delhi NCR"). */
const CITY_TO_REGION: Record<string, string> = {
  Delhi: "Delhi NCR",
  Noida: "Delhi NCR",
  "Greater Noida": "Delhi NCR",
  Gurugram: "Delhi NCR",
  Ghaziabad: "Delhi NCR",
  Faridabad: "Delhi NCR",
  Mumbai: "Mumbai Metropolitan Region",
  Thane: "Mumbai Metropolitan Region",
  "Navi Mumbai": "Mumbai Metropolitan Region",
  Bengaluru: "Bengaluru Metro",
  Pune: "Pune Metro",
  Hyderabad: "Hyderabad Metro",
  Chennai: "Chennai Metro",
  Kolkata: "Kolkata Metro"
};

/** State-name aliases -> canonical spelling, same case-insensitive lookup convention as cities. */
const STATE_ALIASES: Record<string, string> = {
  "uttar pradesh": "Uttar Pradesh",
  up: "Uttar Pradesh",
  karnataka: "Karnataka",
  maharashtra: "Maharashtra",
  "tamil nadu": "Tamil Nadu",
  telangana: "Telangana",
  "west bengal": "West Bengal",
  delhi: "Delhi",
  haryana: "Haryana",
  kerala: "Kerala",
  gujarat: "Gujarat",
  rajasthan: "Rajasthan"
};

export interface NormalizedLocation {
  normalizedCity: string | null;
  normalizedRegion: string | null;
  normalizedState: string | null;
}

/** Looks up a raw, as-extracted city/state string against the alias tables. Returns the ORIGINAL input
 * unchanged (never null-ed out, never guessed) when no alias/region mapping is known for it — this
 * function only ever narrows to a known canonical form or passes the raw text through, consistent with
 * "Do not incorrectly overwrite the original text extracted from the resume" (the raw value is stored
 * separately by the caller; this function only computes what the NORMALIZED columns should hold). */
export function normalizeLocation(rawCity: string | null, rawState: string | null): NormalizedLocation {
  const cityKey = rawCity?.trim().toLowerCase();
  const canonicalCity = cityKey ? (CITY_ALIASES[cityKey] ?? rawCity?.trim() ?? null) : null;
  const stateKey = rawState?.trim().toLowerCase();
  const canonicalState = stateKey ? (STATE_ALIASES[stateKey] ?? rawState?.trim() ?? null) : null;
  const normalizedRegion = canonicalCity ? (CITY_TO_REGION[canonicalCity] ?? null) : null;
  return {
    normalizedCity: canonicalCity,
    normalizedState: canonicalState,
    normalizedRegion
  };
}

/** Used by the filter service's "region" filter — expands a region name back to the set of canonical
 * city names a recruiter searching that region actually means (e.g. "Delhi NCR" -> ["Delhi", "Noida", ...]).
 * Returns an empty array for an unrecognized region rather than guessing. */
export function citiesInRegion(region: string): string[] {
  const target = region.trim().toLowerCase();
  return Object.entries(CITY_TO_REGION)
    .filter(([, mappedRegion]) => mappedRegion.toLowerCase() === target)
    .map(([city]) => city);
}
