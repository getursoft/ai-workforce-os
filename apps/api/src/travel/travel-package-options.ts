/**
 * Structured, persistable simulated flight+hotel package options — Option 1 (Value), Option 2
 * (Recommended), Option 3 (Premium) — for the booking-intent flow. Deliberately separate from
 * travel.runtime.ts's own free-text `buildRecommendationMessage`/indicative-range messages: those remain
 * unchanged and are still used for a plain "recommend hotels/flights" ask; this module is only for the
 * transactional "show me options to book" path, where the traveler must be able to select a SPECIFIC,
 * persisted option by number rather than have the assistant re-parse its own prior prose.
 *
 * Every number here is deterministic (no randomness) so the same trip state always regenerates the same
 * three options — selection is still validated against the PERSISTED option set from the turn it was
 * shown, never recomputed from scratch, but determinism keeps this module trivially testable and keeps a
 * "show options" retry (before selection) visually stable rather than jittering on every regeneration.
 */

import { formatMoney } from "./currency.service";
import { addDays, estimateBudgetRange, type TravelEntities, type TravelEmployeeRuntimeConfig } from "./travel.runtime";

export type PackageOptionTier = "VALUE" | "RECOMMENDED" | "PREMIUM";

/** One traveler's identity details, collected before a booking is ever submitted — a real ticket must
 *  name every passenger, not a generic "Passenger 1"/"Passenger 2" placeholder. */
export interface PassengerDetail {
  name: string;
  age: number;
  gender: "MALE" | "FEMALE" | "OTHER";
}

export interface SimulatedFlightOption {
  carrierName: string;
  flightNumber: string;
  outboundDepartureTime: string;
  outboundArrivalTime: string;
  returnFlightNumber: string | null;
  returnDepartureTime: string | null;
  returnArrivalTime: string | null;
  stops: number;
  cabinClass: string;
  baggage: string;
  pricePerTraveller: number;
  totalFlightPrice: number;
}

export interface SimulatedHotelOption {
  hotelName: string;
  area: string;
  starRating: number;
  roomType: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  numberOfRooms: number;
  mealPlan: string;
  vegetarianFriendly: boolean;
  totalHotelPrice: number;
}

export interface SimulatedPackageOption {
  recommendationId: string;
  optionNumber: 1 | 2 | 3;
  optionType: PackageOptionTier;
  originCity: string | null;
  destinationCity: string | null;
  tripType: string;
  outboundDate: string | null;
  returnDate: string | null;
  travellers: number;
  flight: SimulatedFlightOption;
  hotel: SimulatedHotelOption | null;
  taxesAndFees: number;
  totalAmount: number;
  currency: string;
  status: "ACTIVE" | "SELECTED" | "EXPIRED";
  generatedAt: string;
  expiresAt: string;
  isSimulated: true;
}

const OPTION_TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough for a normal conversational pace.

const VALUE_CARRIERS = ["Air India", "IndiGo", "SpiceJet"];
const RECOMMENDED_CARRIERS = ["Emirates", "Vistara", "Qatar Airways"];
const PREMIUM_CARRIERS = ["Emirates", "Singapore Airlines", "Etihad Airways"];

const TIER_CONFIG: Record<
  PackageOptionTier,
  { label: string; multiplier: number; cabin: string; stops: number; baggage: string; hotelStars: number; mealPlan: string; roomType: string }
> = {
  VALUE: { label: "Value", multiplier: 0.85, cabin: "Economy", stops: 1, baggage: "1 checked bag (20kg)", hotelStars: 4, mealPlan: "Room Only", roomType: "Standard Room" },
  RECOMMENDED: { label: "Recommended", multiplier: 1.0, cabin: "Economy Flex", stops: 0, baggage: "2 checked bags (23kg each)", hotelStars: 4, mealPlan: "Breakfast Included", roomType: "Deluxe Room" },
  PREMIUM: { label: "Premium", multiplier: 1.45, cabin: "Premium Economy", stops: 0, baggage: "2 checked bags (32kg each), priority handling", hotelStars: 5, mealPlan: "Breakfast + Dinner", roomType: "Executive Suite" }
};

/** Deterministic per-destination hotel-area picks by tier — falls back to a generic (still destination-
 *  named) area for any destination not in this short curated list, so the generator never breaks on an
 *  unrecognized city. */
const DESTINATION_AREAS: Record<string, Record<PackageOptionTier, string>> = {
  dubai: { VALUE: "Deira", RECOMMENDED: "Downtown Dubai", PREMIUM: "Business Bay" },
  singapore: { VALUE: "Little India", RECOMMENDED: "Orchard Road", PREMIUM: "Marina Bay" },
  london: { VALUE: "Earls Court", RECOMMENDED: "Covent Garden", PREMIUM: "Mayfair" },
  paris: { VALUE: "Montmartre", RECOMMENDED: "Le Marais", PREMIUM: "Champs-Élysées" }
};

function areaFor(destinationCity: string | null, tier: PackageOptionTier): string {
  const key = (destinationCity ?? "").trim().toLowerCase();
  const known = DESTINATION_AREAS[key];
  if (known) return known[tier];
  const suffix = tier === "VALUE" ? "Old Town" : tier === "RECOMMENDED" ? "City Center" : "Business District";
  return destinationCity ? `${destinationCity} ${suffix}` : suffix;
}

function pick(list: readonly string[], seed: number): string {
  return list[seed % list.length] ?? list[0] ?? "Unnamed Carrier";
}

function flightNumberFor(carrier: string, seed: number): string {
  const code = carrier
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
    .padEnd(2, "X");
  return `${code}${100 + ((seed * 37) % 800)}`;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Round-trip return-date rule: the project's existing single canonical convention (see
 *  `TravelEntities.days` doc — a stated N-day trip means N-1 nights, departure + (N-1) nights = return on
 *  day N). Never invents a second convention; mirrors how `nights` is already derived from `days`
 *  elsewhere in this file (`days - 1`). Returns null when either the departure date or a duration isn't
 *  known yet — callers must not fabricate a date from nothing. */
export function computeReturnDate(entities: TravelEntities): string | null {
  if (entities.returnDate) return entities.returnDate;
  if (!entities.departureDate) return null;
  const nights = entities.nights ?? (entities.days !== null ? entities.days - 1 : null);
  if (nights === null || nights < 0) return null;
  const departure = new Date(`${entities.departureDate}T00:00:00.000Z`);
  if (Number.isNaN(departure.getTime())) return null;
  return formatIsoDate(addDays(departure, nights));
}

/** A stable per-trip seed for `generateSimulatedPackageOptions`'s deterministic carrier/flight-number
 *  pick — built from trip facts (not a conversation id, which `TravelEmployeeProvider` doesn't carry)
 *  so the same trip always regenerates the same simulated flight numbers if options expire and are
 *  regenerated mid-conversation. */
export function packageOptionSeed(entities: TravelEntities): string {
  return `${entities.destinationCity ?? ""}|${entities.departureDate ?? entities.travelMonth ?? ""}|${entities.customerName ?? ""}|${entities.adults ?? entities.totalTravellers ?? ""}`;
}

/**
 * Generates exactly three structured, simulated flight+hotel package options for the current trip state.
 * Reuses the existing deterministic estimate engine (`estimateBudgetRange`) as the pricing source of
 * truth — each tier is a deterministic multiplier of that same estimate, never an unrelated invented
 * number, so the three options stay consistent with whatever budget guidance the traveler already saw.
 */
export function generateSimulatedPackageOptions(
  entities: TravelEntities,
  config: TravelEmployeeRuntimeConfig,
  conversationSeed: string
): SimulatedPackageOption[] {
  const estimate = estimateBudgetRange(entities, config);
  const currency = estimate.currency;
  const travellers = Math.max(1, entities.adults ?? entities.totalTravellers ?? 1);
  const tripType = entities.tripType === "ROUND_TRIP" ? "ROUND_TRIP" : entities.tripType === "ONE_WAY" ? "ONE_WAY" : "ROUND_TRIP";
  const outboundDate = entities.departureDate;
  const returnDate = tripType === "ROUND_TRIP" ? computeReturnDate(entities) : null;
  const vegetarian = entities.preferences.some((preference) => preference.toUpperCase().includes("VEGETARIAN"));

  // A small numeric seed derived from the conversation id keeps carrier/flight-number pick stable across
  // regenerations for the SAME conversation without needing Math.random (which would break determinism).
  let seed = 0;
  for (let i = 0; i < conversationSeed.length; i++) seed = (seed * 31 + conversationSeed.charCodeAt(i)) % 997;

  const tiers: PackageOptionTier[] = ["VALUE", "RECOMMENDED", "PREMIUM"];
  const now = new Date();
  const generatedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + OPTION_TTL_MS).toISOString();

  return tiers.map((tier, index) => {
    const optionNumber = (index + 1) as 1 | 2 | 3;
    const tierConfig = TIER_CONFIG[tier];
    const carrierList = tier === "VALUE" ? VALUE_CARRIERS : tier === "RECOMMENDED" ? RECOMMENDED_CARRIERS : PREMIUM_CARRIERS;
    const carrier = pick(carrierList, seed + optionNumber);
    const flightNumber = flightNumberFor(carrier, seed + optionNumber);

    const totalBeforeTax = Math.round(((estimate.low + estimate.high) / 2) * tierConfig.multiplier);
    const hotelShare = 0.4;
    const totalHotelPrice = Math.round(totalBeforeTax * hotelShare);
    const totalFlightPrice = Math.max(0, totalBeforeTax - totalHotelPrice);
    const taxesAndFees = Math.round(totalBeforeTax * 0.08);
    const totalAmount = totalFlightPrice + totalHotelPrice + taxesAndFees;

    const flight: SimulatedFlightOption = {
      carrierName: carrier,
      flightNumber,
      outboundDepartureTime: outboundDate ? `${outboundDate}T09:${(15 + optionNumber * 10) % 60}:00Z` : "TBD",
      outboundArrivalTime: outboundDate ? `${outboundDate}T13:${(15 + optionNumber * 10) % 60}:00Z` : "TBD",
      returnFlightNumber: tripType === "ROUND_TRIP" ? flightNumberFor(carrier, seed + optionNumber + 1) : null,
      returnDepartureTime: tripType === "ROUND_TRIP" && returnDate ? `${returnDate}T18:${(20 + optionNumber * 10) % 60}:00Z` : null,
      returnArrivalTime: tripType === "ROUND_TRIP" && returnDate ? `${returnDate}T22:${(20 + optionNumber * 10) % 60}:00Z` : null,
      stops: tierConfig.stops,
      cabinClass: tierConfig.cabin,
      baggage: tierConfig.baggage,
      pricePerTraveller: Math.round(totalFlightPrice / travellers),
      totalFlightPrice
    };

    const hotel: SimulatedHotelOption | null = entities.destinationCity
      ? {
          hotelName: `${areaFor(entities.destinationCity, tier)} ${tierConfig.hotelStars}-Star Hotel`,
          area: areaFor(entities.destinationCity, tier),
          starRating: tierConfig.hotelStars,
          roomType: tierConfig.roomType,
          checkInDate: outboundDate,
          checkOutDate: returnDate,
          numberOfRooms: Math.max(1, Math.ceil(travellers / 2)),
          mealPlan: tierConfig.mealPlan,
          vegetarianFriendly: vegetarian ? true : tier !== "VALUE",
          totalHotelPrice
        }
      : null;

    return {
      recommendationId: `${conversationSeed.slice(0, 8)}-opt${optionNumber}-${seed}`,
      optionNumber,
      optionType: tier,
      originCity: entities.originCity,
      destinationCity: entities.destinationCity,
      tripType,
      outboundDate,
      returnDate,
      travellers,
      flight,
      hotel,
      taxesAndFees,
      totalAmount,
      currency,
      status: "ACTIVE",
      generatedAt,
      expiresAt,
      isSimulated: true
    };
  });
}

/** Renders the "Option 1 — Value / Option 2 — Recommended / Option 3 — Premium" chat message. */
export function formatPackageOptionsMessage(options: readonly SimulatedPackageOption[]): string {
  const lines: string[] = ["Here are three simulated package options for your trip:", ""];
  for (const option of options) {
    const tierConfig = TIER_CONFIG[option.optionType];
    lines.push(`Option ${option.optionNumber} — ${tierConfig.label}`);
    lines.push(
      `- Simulated ${option.flight.carrierName} ${option.tripType === "ROUND_TRIP" ? "round trip" : "one-way"} (${option.flight.stops === 0 ? "direct" : `${option.flight.stops} stop`})`
    );
    lines.push(`- ${option.flight.cabinClass}, ${option.flight.baggage}`);
    if (option.hotel) {
      lines.push(
        `- ${option.hotel.area} ${option.hotel.starRating}-star hotel${option.hotel.vegetarianFriendly ? " (vegetarian-friendly)" : ""}, ${option.hotel.mealPlan}`
      );
    }
    lines.push(`- Total: ${formatMoney(option.totalAmount, option.currency)}`);
    lines.push("");
  }
  lines.push("These are simulated packages, not real airline or hotel inventory.");
  lines.push("Please select Option 1, Option 2 or Option 3.");
  return lines.join("\n");
}

const ORDINAL_WORDS: Record<string, 1 | 2 | 3> = {
  "1": 1, one: 1, first: 1, "1st": 1, value: 1, economy: 1,
  "2": 2, two: 2, second: 2, "2nd": 2, recommended: 2, balanced: 2,
  "3": 3, three: 3, third: 3, "3rd": 3, premium: 3, flexible: 3
};

// Matches "option 2", "select 1", "go with option 1", "choose the second one", "recommended option",
// "premium option", or a bare "1"/"2"/"3" (only meaningful when the caller knows options are pending —
// see the AWAITING_SELECTION phase gate at the call site, which is what makes a bare digit reply safe
// here rather than colliding with an unrelated numeric answer like a duration or passenger count).
const OPTION_SELECTION_PATTERN =
  /\b(?:option|pick|choose|select|go\s+with)\s*(?:#)?\s*(1|2|3|one|two|three|first|second|third)\b|\b(first|second|third)\s+option\b|\b(value|economy|recommended|balanced|premium|flexible)\s+option\b|\bthe\s+(1st|2nd|3rd)\s+one\b/i;
const BARE_DIGIT_PATTERN = /^\s*(1|2|3)\s*$/;

export function detectOptionSelection(text: string): 1 | 2 | 3 | null {
  const trimmed = text.trim();
  const bareMatch = BARE_DIGIT_PATTERN.exec(trimmed);
  if (bareMatch?.[1]) return Number(bareMatch[1]) as 1 | 2 | 3;
  const match = OPTION_SELECTION_PATTERN.exec(trimmed);
  if (!match) return null;
  const word = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").toLowerCase();
  return ORDINAL_WORDS[word] ?? null;
}

/** True once `expiresAt` has passed — an expired option set must be regenerated, never silently selected. */
export function isOptionSetExpired(options: readonly SimulatedPackageOption[], now: Date = new Date()): boolean {
  const first = options[0];
  if (!first) return true;
  return new Date(first.expiresAt).getTime() < now.getTime();
}

// One passenger per line/semicolon-separated segment: an optional "1." numbering, then a name (letters,
// spaces, apostrophes, hyphens, dots), then a separator, an age (1-3 digits, optionally followed by
// "years"/"yrs"/"y.o."), another separator, and a gender word. Deliberately requires all three fields in
// one segment — a bare name or a bare age is too ambiguous to guess at for something that ends up on a
// travel document.
const PASSENGER_LINE_PATTERN =
  /^\s*(?:\d{1,2}[.)]\s*)?([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*)[\s,-]+(\d{1,3})\s*(?:years?|yrs?|y\.?o\.?)?[\s,-]+(male|female|other|non-?binary|m|f)\b/i;

/** Parses "1. Rahul Sharma, 32, Male; 2. Priya Sharma, 29, Female" (newline- or semicolon-separated, with
 *  or without numbering) into individual passenger records. Segments that don't confidently contain a
 *  name + age + gender are silently skipped — the caller re-prompts for whatever's still missing rather
 *  than guessing, since this data ends up printed on a ticket. */
export function parsePassengerDetailsReply(text: string): PassengerDetail[] {
  const segments = text
    .split(/[\n;]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const results: PassengerDetail[] = [];
  for (const segment of segments) {
    const match = PASSENGER_LINE_PATTERN.exec(segment);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const age = Number(match[2]);
    if (!Number.isFinite(age) || age < 1 || age > 120) continue;
    const name = match[1].trim().replace(/\s+/g, " ");
    if (!name) continue;
    const genderWord = match[3].toLowerCase();
    const gender: PassengerDetail["gender"] =
      genderWord === "m" || genderWord === "male"
        ? "MALE"
        : genderWord === "f" || genderWord === "female"
          ? "FEMALE"
          : "OTHER";
    results.push({ name, age, gender });
  }
  return results;
}

/** Prompt asking for the remaining passengers' full name, age, and gender — shown once a package option
 *  is selected and again (listing what's already recorded) if a reply only partially answers it. Gating
 *  the booking on this, rather than fabricating "Passenger 1"/"Passenger 2" placeholders, is what makes
 *  the generated ticket usable as an actual travel document. */
export function buildPassengerDetailsRequestMessage(
  totalTravellers: number,
  alreadyCollected: readonly PassengerDetail[]
): string {
  const remaining = totalTravellers - alreadyCollected.length;
  const lines = [
    alreadyCollected.length
      ? `Thanks — I still need the full name, age, and gender for ${remaining} more traveller(s) (${totalTravellers} total).`
      : `Before I can confirm this booking, I need the full name, age, and gender for each traveller (${totalTravellers} total).`,
    `Please list them like: "1. Full Name, Age, Gender" — one per line or separated by semicolons.`
  ];
  if (alreadyCollected.length) {
    lines.push("");
    lines.push("Already recorded:");
    alreadyCollected.forEach((passenger, index) => {
      lines.push(`${index + 1}. ${passenger.name}, ${passenger.age}, ${passenger.gender}`);
    });
  }
  return lines.join("\n");
}

/** Final booking-confirmation summary — spec format: route, dates, travellers, selected flight/hotel,
 *  total, food preference, then the explicit confirm/change prompt. `passengers`, when provided, lists
 *  each traveller's name/age/gender so the customer can visually verify the exact roster that will be
 *  printed on the ticket before confirming. */
export function buildBookingConfirmationSummary(
  entities: TravelEntities,
  option: SimulatedPackageOption,
  passengers: readonly PassengerDetail[] = []
): string {
  const route =
    option.tripType === "ROUND_TRIP" && option.originCity && option.destinationCity
      ? `${option.originCity} → ${option.destinationCity} → ${option.originCity}`
      : option.originCity && option.destinationCity
        ? `${option.originCity} → ${option.destinationCity}`
        : (option.destinationCity ?? "your destination");
  const dateRange =
    option.outboundDate && option.returnDate
      ? `${option.outboundDate} to ${option.returnDate}`
      : (option.outboundDate ?? "dates to be confirmed");
  const vegetarian = entities.preferences.some((preference) => preference.toUpperCase().includes("VEGETARIAN"));

  const lines = [
    "Please confirm your simulated booking:",
    "",
    route,
    dateRange,
    `${option.travellers} traveller(s)`,
    `Flight: ${option.flight.carrierName} ${option.flight.flightNumber} (${option.flight.cabinClass})`,
    option.hotel ? `Hotel: ${option.hotel.hotelName} (${option.hotel.roomType}, ${option.hotel.mealPlan})` : null,
    `Total: ${formatMoney(option.totalAmount, option.currency)}`,
    vegetarian ? "Food preference: Vegetarian" : null,
    ...(passengers.length
      ? [
          "",
          "Travellers:",
          ...passengers.map((passenger, index) => `${index + 1}. ${passenger.name}, ${passenger.age}, ${passenger.gender}`)
        ]
      : []),
    "",
    "This is a simulated booking in the Krevia.ai demo environment — no real reservation is made until you confirm.",
    "",
    "Reply 'Confirm booking' to proceed, or 'Change option' to choose another package."
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

/** "No, show other options" / "change option" — a rejection of the current selection, distinct from a
 *  flat booking rejection. Recognized separately so the caller can re-show the SAME persisted options
 *  (not regenerate) rather than starting the whole flow over. */
const CHANGE_OPTION_PATTERN = /\b(?:change|different|another|other)\s+(?:option|package)s?\b|\bshow\s+(?:me\s+)?(?:other|different)\s+options?\b|\bno,?\s+(?:show\s+)?other\s+options?\b/i;
export function isChangeOptionRequest(text: string): boolean {
  return CHANGE_OPTION_PATTERN.test(text);
}

/**
 * Deterministic classification of an explicit "yes, book it" reply to the final booking-confirmation
 * summary — deliberately the SAME narrow affirmative-only shape as
 * `workflows/booking-handoff/booking-confirmation.ts`'s `isExplicitBookingConfirmation` (never imported
 * from there: this file must stay a one-way dependency of the workflows layer, not the reverse — see
 * travel.runtime.ts's own note on `TravelWorkflowSignalDraft`). An ambiguous reply is treated as NOT
 * confirmed, matching the "never treat a generic yes as confirmation unless pending question IS the
 * confirmation" requirement — this function is only ever consulted while that exact question is pending.
 */
const BOOKING_CONFIRMATION_AFFIRMATIVE_PATTERN =
  /^\s*(?:yes|yeah|yep|yup|confirm(?:ed)?\s*booking|confirm(?:ed)?|go\s*ahead|please\s*proceed|proceed|book\s+(?:this|it)|book\s+this\s+option|sure|ok|okay)\b/i;
const BOOKING_CONFIRMATION_NEGATIVE_PATTERN = /^\s*(?:no|nope|not\s*now|don'?t|do\s*not)\b/i;
export function isExplicitBookingConfirmationReply(text: string): boolean {
  const trimmed = text.trim();
  return BOOKING_CONFIRMATION_AFFIRMATIVE_PATTERN.test(trimmed) && !BOOKING_CONFIRMATION_NEGATIVE_PATTERN.test(trimmed);
}
