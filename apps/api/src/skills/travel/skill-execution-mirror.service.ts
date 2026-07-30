import { Injectable } from "@nestjs/common";
import type { PlanTripSkillState } from "./plan-trip.skill";
import type { TravelEntities } from "../../travel/travel.runtime";

/**
 * SkillExecutionMirrorService: Mirrors Skill Runtime state back to travel.trip_state.
 *
 * Stage 8: SkillExecution is canonical. travel.trip_state is compatibility-only.
 *
 * This service updates travel.trip_state to mirror the Skill Runtime's canonical data
 * so that legacy code paths and reporting can still access it. No business logic
 * should depend on travel.trip_state anymore — all decisions go through Skill Runtime.
 */
@Injectable()
export class SkillExecutionMirrorService {
  /**
   * Mirror Skill Runtime state into travel.trip_state entities.
   * This enables backward compatibility for diagnostics and legacy code.
   */
  mirrorStateToTravelEntities(skillState: PlanTripSkillState): Partial<TravelEntities> {
    const mirror: Partial<TravelEntities> = {};

    // Origin city
    if (skillState.origin) {
      mirror.originCity = skillState.origin;
    }

    // Destination city
    if (skillState.destination) {
      mirror.destinationCity = skillState.destination;
    }

    // Departure date (prefer full date, fall back to value)
    if (skillState.departureDate) {
      if (skillState.departureDate.value && this.isValidIsoDate(skillState.departureDate.value)) {
        mirror.departureDate = skillState.departureDate.value;
      }
      if (skillState.departureDate.month) {
        // Store month for legacy code
        mirror.travelMonth = this.monthNumberToName(skillState.departureDate.month);
      }
    }

    // Return date
    if (skillState.returnDate) {
      if (skillState.returnDate.value && this.isValidIsoDate(skillState.returnDate.value)) {
        mirror.returnDate = skillState.returnDate.value;
      }
    }

    // Duration
    if (skillState.duration) {
      if (skillState.duration.unit === "DAYS") {
        mirror.days = skillState.duration.value;
      } else if (skillState.duration.unit === "NIGHTS") {
        mirror.nights = skillState.duration.value;
      }
    }

    // Travellers
    if (skillState.travellers) {
      if (skillState.travellers.total !== null) {
        mirror.totalTravellers = skillState.travellers.total;
      }
      if (skillState.travellers.adults !== null) {
        mirror.adults = skillState.travellers.adults;
      }
      if (skillState.travellers.children !== null) {
        mirror.children = skillState.travellers.children;
      }
      if (skillState.travellers.infants !== null) {
        mirror.infants = skillState.travellers.infants;
      }
    }

    // Budget
    if (skillState.budget) {
      mirror.budget = skillState.budget.amount;
      mirror.budgetCurrency = skillState.budget.currency;
    }

    // Purpose (trip type)
    if (skillState.purpose) {
      mirror.tripType = skillState.purpose;
    }

    return mirror;
  }

  /**
   * Check if a string is a valid ISO 8601 date.
   */
  private isValidIsoDate(dateString: string): boolean {
    if (typeof dateString !== "string") return false;
    const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!isoPattern.test(dateString)) return false;
    const date = new Date(dateString + "T00:00:00Z");
    return !isNaN(date.getTime());
  }

  /**
   * Convert month number (1-12) to month name.
   */
  private monthNumberToName(month: number): string {
    const months = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];
    return months[month - 1] || "";
  }
}
