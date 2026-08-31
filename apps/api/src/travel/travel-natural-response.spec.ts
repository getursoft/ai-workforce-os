import { describe, expect, it } from "vitest";
import { formatMoney } from "./currency.service";
import {
  buildBookingConfirmationSummary,
  buildPassengerDetailsRequestMessage,
  formatPackageOptionsMessage,
  formatPackageOptionsMessageForVoice,
  generateSimulatedPackageOptions,
  packageOptionSeed,
  type PassengerDetail
} from "./travel-package-options";
import {
  buildTicketContactRequestMessage,
  DEFAULT_TRAVEL_EMPLOYEE_CONFIG,
  EMPTY_TRAVEL_ENTITIES,
  type TravelEntities
} from "./travel.runtime";

/**
 * Travel Booking Closure Pass — Phase 22: naturalness / property-style regression tests. These run the
 * SAME deterministic composer functions across many different trip shapes (destinations, currencies,
 * traveller counts, single vs round trip) rather than asserting one exact hand-picked sentence — so a
 * future wording tweak doesn't have to break every test, but the underlying guarantees (no enum leakage,
 * no invented numbers, no robotic numbered-menu phrasing, voice output free of markdown) can't regress
 * silently either.
 */

const RAW_ENUM_LEAK_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

const TRIP_FIXTURES: TravelEntities[] = [
  {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Krishna",
    originCity: "Delhi",
    destinationCity: "Dubai",
    departureDate: "2026-08-12",
    days: 5,
    adults: 3,
    tripType: "ROUND_TRIP",
    budget: 100000,
    budgetCurrency: "AED"
  },
  {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Meera",
    originCity: "Mumbai",
    destinationCity: "Singapore",
    departureDate: "2026-11-01",
    days: 3,
    adults: 1,
    tripType: "ONE_WAY",
    budget: 60000,
    budgetCurrency: "INR"
  },
  {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Arjun",
    originCity: "New York",
    destinationCity: "London",
    departureDate: "2027-01-15",
    days: 10,
    adults: 2,
    tripType: "ROUND_TRIP",
    budget: 8000,
    budgetCurrency: "USD"
  },
  {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Zoya",
    originCity: "Karachi",
    destinationCity: "Paris",
    departureDate: "2026-09-20",
    days: 7,
    adults: 4,
    tripType: "ROUND_TRIP",
    budget: 500000,
    budgetCurrency: "AED"
  },
  {
    ...EMPTY_TRAVEL_ENTITIES,
    customerName: "Tomas",
    originCity: "Berlin",
    destinationCity: "Nairobi",
    departureDate: "2026-12-05",
    days: 1,
    adults: 1,
    tripType: "ONE_WAY",
    budget: 2000,
    budgetCurrency: "USD"
  }
];

function optionsFor(entities: TravelEntities) {
  return generateSimulatedPackageOptions(entities, DEFAULT_TRAVEL_EMPLOYEE_CONFIG, packageOptionSeed(entities));
}

function passengersFor(count: number): PassengerDetail[] {
  const names = ["Krishna Pandey", "Rekha Pandey", "Aarav Pandey", "Zoya Khan", "Tomas Weber"];
  return Array.from({ length: count }, (_, index) => ({
    name: names[index % names.length] ?? "Traveller",
    age: 20 + index,
    gender: (["MALE", "FEMALE", "OTHER"] as const)[index % 3]
  }));
}

describe("Travel natural-response naturalness properties (Phase 22)", () => {
  describe("no raw workflow enum leakage to the customer", () => {
    for (const entities of TRIP_FIXTURES) {
      it(`formatPackageOptionsMessage never leaks a SCREAMING_SNAKE_CASE token (${entities.destinationCity})`, () => {
        const message = formatPackageOptionsMessage(optionsFor(entities));
        expect(message).not.toMatch(RAW_ENUM_LEAK_PATTERN);
      });

      it(`formatPackageOptionsMessageForVoice never leaks a SCREAMING_SNAKE_CASE token (${entities.destinationCity})`, () => {
        const message = formatPackageOptionsMessageForVoice(optionsFor(entities));
        expect(message).not.toMatch(RAW_ENUM_LEAK_PATTERN);
      });

      it(`buildBookingConfirmationSummary never leaks a SCREAMING_SNAKE_CASE token (${entities.destinationCity})`, () => {
        const options = optionsFor(entities);
        const summary = buildBookingConfirmationSummary(
          entities,
          options[1] ?? options[0]!,
          passengersFor(entities.adults ?? 1)
        );
        expect(summary).not.toMatch(RAW_ENUM_LEAK_PATTERN);
      });
    }

    it("buildPassengerDetailsRequestMessage and buildTicketContactRequestMessage never leak an enum token", () => {
      expect(buildPassengerDetailsRequestMessage(3, [])).not.toMatch(RAW_ENUM_LEAK_PATTERN);
      expect(buildPassengerDetailsRequestMessage(1, [])).not.toMatch(RAW_ENUM_LEAK_PATTERN);
      expect(buildTicketContactRequestMessage()).not.toMatch(RAW_ENUM_LEAK_PATTERN);
    });
  });

  describe("prices are never invented — the composed text always matches the authoritative option data", () => {
    for (const entities of TRIP_FIXTURES) {
      it(`formatPackageOptionsMessage's three totals exactly match each option's own totalAmount (${entities.destinationCity})`, () => {
        const options = optionsFor(entities);
        const message = formatPackageOptionsMessage(options);
        for (const option of options) {
          expect(message).toContain(formatMoney(option.totalAmount, option.currency));
        }
      });

      it(`buildBookingConfirmationSummary's total exactly matches the selected option's totalAmount, never another option's (${entities.destinationCity})`, () => {
        const options = optionsFor(entities);
        const selected = options[1] ?? options[0]!;
        const other = options.find((option) => option.optionNumber !== selected.optionNumber);
        const summary = buildBookingConfirmationSummary(entities, selected, []);
        expect(summary).toContain(formatMoney(selected.totalAmount, selected.currency));
        if (other && other.totalAmount !== selected.totalAmount) {
          expect(summary).not.toContain(formatMoney(other.totalAmount, other.currency));
        }
      });

      it(`formatPackageOptionsMessageForVoice's quoted price matches the RECOMMENDED option's own totalAmount (${entities.destinationCity})`, () => {
        const options = optionsFor(entities);
        const recommended = options.find((option) => option.optionType === "RECOMMENDED")!;
        const voice = formatPackageOptionsMessageForVoice(options);
        expect(voice).toContain(formatMoney(recommended.totalAmount, recommended.currency));
      });
    }
  });

  describe("no robotic numbered-menu phrasing where a natural ask is expected", () => {
    const OLD_ROBOTIC_PROMPT = /please select option 1,\s*option 2 or option 3/i;
    for (const entities of TRIP_FIXTURES) {
      it(`the options-ask closing line is natural, not the old numbered-menu prompt (${entities.destinationCity})`, () => {
        const message = formatPackageOptionsMessage(optionsFor(entities));
        expect(message).not.toMatch(OLD_ROBOTIC_PROMPT);
        expect(message).toMatch(/value, recommended, or premium/i);
      });
    }

    it("passenger-details ask never uses a robotic '(3 total)' style count suffix", () => {
      expect(buildPassengerDetailsRequestMessage(3, [])).not.toMatch(/\(\d+\s*total\)/i);
      expect(buildPassengerDetailsRequestMessage(1, [])).not.toMatch(/\(\d+\s*total\)/i);
    });
  });

  describe("voice-channel output has no markdown (Phase 15/25 voice-readiness)", () => {
    const MARKDOWN_PATTERN = /[*_`#]|^\s*-\s|\n\n/m;
    for (const entities of TRIP_FIXTURES) {
      it(`formatPackageOptionsMessageForVoice is markdown-free prose (${entities.destinationCity})`, () => {
        const voice = formatPackageOptionsMessageForVoice(optionsFor(entities));
        expect(voice).not.toMatch(MARKDOWN_PATTERN);
        // Short, spoken-style: no bullet-per-option enumeration of all three options' full detail.
        expect(voice.split(/[.!?]\s/).length).toBeLessThanOrEqual(4);
      });
    }
  });

  describe("transactional facts remain present even after natural-language rewriting", () => {
    for (const entities of TRIP_FIXTURES) {
      it(`buildBookingConfirmationSummary always states route, dates, traveller count, and total (${entities.destinationCity})`, () => {
        const options = optionsFor(entities);
        const selected = options[1] ?? options[0]!;
        const summary = buildBookingConfirmationSummary(entities, selected, passengersFor(selected.travellers));
        if (selected.originCity) expect(summary).toContain(selected.originCity);
        if (selected.destinationCity) expect(summary).toContain(selected.destinationCity);
        expect(summary).toContain(`${selected.travellers} traveller(s)`);
        expect(summary).toContain(formatMoney(selected.totalAmount, selected.currency));
        expect(summary).toMatch(/confirm booking/i);
        expect(summary).toMatch(/simulated/i);
      });

      it(`buildBookingConfirmationSummary lists every named passenger, in order, when provided (${entities.destinationCity})`, () => {
        const options = optionsFor(entities);
        const selected = options[1] ?? options[0]!;
        const passengers = passengersFor(selected.travellers);
        const summary = buildBookingConfirmationSummary(entities, selected, passengers);
        passengers.forEach((passenger, index) => {
          expect(summary).toContain(`${index + 1}. ${passenger.name}, ${passenger.age}, ${passenger.gender}`);
        });
      });
    }
  });
});
