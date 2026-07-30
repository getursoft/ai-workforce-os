import { Injectable } from "@nestjs/common";
import type { PendingInputCode } from "./input-decision.dto.js";

/**
 * PendingInputQuestionService: Generates natural language questions for pending input.
 *
 * Skill Runtime decides WHAT to ask (pendingInput code).
 * This service decides HOW to phrase the question.
 *
 * Travel Runtime can customize the language/tone based on conversation context.
 */
@Injectable()
export class PendingInputQuestionService {
  /**
   * Generate a question prompt for a pending input code.
   *
   * @param pendingInput The field code (e.g., "TRAVEL_YEAR")
   * @param conversationLanguage Optional language preference
   * @returns A natural language question
   */
  generateQuestion(
    pendingInput: PendingInputCode,
    conversationLanguage: string = "ENGLISH"
  ): string {
    const languageKey = conversationLanguage.toUpperCase() as keyof typeof QUESTION_TEMPLATES;
    const templates = QUESTION_TEMPLATES[languageKey] || QUESTION_TEMPLATES.ENGLISH;

    switch (pendingInput) {
      case "ORIGIN":
        return templates.ORIGIN;
      case "DESTINATION":
        return templates.DESTINATION;
      case "DEPARTURE_DATE":
        return templates.DEPARTURE_DATE;
      case "TRAVEL_YEAR":
        return templates.TRAVEL_YEAR;
      case "TRAVELLERS":
        return templates.TRAVELLERS;
      case "TRAVELLER_COMPOSITION":
        return templates.TRAVELLER_COMPOSITION;
      case "DURATION":
        return templates.DURATION;
      case null:
        return templates.NO_PENDING_INPUT;
      default:
        return templates.UNKNOWN_FIELD;
    }
  }

  /**
   * Generate a brief prompt for inline questions.
   */
  generateBriefPrompt(pendingInput: PendingInputCode): string {
    switch (pendingInput) {
      case "ORIGIN":
        return "Where are you traveling from?";
      case "DESTINATION":
        return "Where are you traveling to?";
      case "DEPARTURE_DATE":
        return "When are you planning to depart?";
      case "TRAVEL_YEAR":
        return "What year?";
      case "TRAVELLERS":
        return "How many travelers?";
      case "TRAVELLER_COMPOSITION":
        return "How many adults, children, and infants?";
      case "DURATION":
        return "How long is your trip?";
      case null:
        return "";
      default:
        return "Please provide more information.";
    }
  }
}

/**
 * Question templates in multiple languages.
 * Extend this object to support additional languages.
 */
const QUESTION_TEMPLATES = {
  ENGLISH: {
    ORIGIN: "Where are you traveling from?",
    DESTINATION: "Where are you traveling to?",
    DEPARTURE_DATE: "When are you planning to travel?",
    TRAVEL_YEAR: "What year?",
    TRAVELLERS: "How many people will be traveling?",
    TRAVELLER_COMPOSITION:
      "Can you provide the breakdown? How many adults, children, and infants?",
    DURATION: "How long is your trip? (in days or nights)",
    NO_PENDING_INPUT: "Your trip details are complete. Ready to proceed!",
    UNKNOWN_FIELD: "Please provide more information about your trip."
  },
  SPANISH: {
    ORIGIN: "¿De dónde viaja?",
    DESTINATION: "¿A dónde viaja?",
    DEPARTURE_DATE: "¿Cuándo planea viajar?",
    TRAVEL_YEAR: "¿Qué año?",
    TRAVELLERS: "¿Cuántas personas viajarán?",
    TRAVELLER_COMPOSITION:
      "¿Puede proporcionar el desglose? ¿Cuántos adultos, niños e infantes?",
    DURATION: "¿Cuánto durará su viaje? (en días o noches)",
    NO_PENDING_INPUT: "Los detalles de su viaje están completos. ¡Listo para continuar!",
    UNKNOWN_FIELD: "Proporcione más información sobre su viaje."
  },
  FRENCH: {
    ORIGIN: "D'où voyagez-vous?",
    DESTINATION: "Où allez-vous?",
    DEPARTURE_DATE: "Quand prévoyez-vous de voyager?",
    TRAVEL_YEAR: "Quelle année?",
    TRAVELLERS: "Combien de personnes voyageront?",
    TRAVELLER_COMPOSITION:
      "Pouvez-vous fournir la ventilation? Combien d'adultes, d'enfants et de nourrissons?",
    DURATION: "Combien de temps durera votre voyage? (en jours ou nuits)",
    NO_PENDING_INPUT: "Les détails de votre voyage sont complets. Prêt à continuer!",
    UNKNOWN_FIELD: "Veuillez fournir plus d'informations sur votre voyage."
  },
  GERMAN: {
    ORIGIN: "Von wo reisen Sie?",
    DESTINATION: "Wohin reisen Sie?",
    DEPARTURE_DATE: "Wann planen Sie zu reisen?",
    TRAVEL_YEAR: "Welches Jahr?",
    TRAVELLERS: "Wie viele Personen reisen?",
    TRAVELLER_COMPOSITION:
      "Können Sie die Aufteilung angeben? Wie viele Erwachsene, Kinder und Kleinkinder?",
    DURATION: "Wie lange dauert Ihre Reise? (in Tagen oder Nächten)",
    NO_PENDING_INPUT: "Die Details Ihrer Reise sind vollständig. Bereit zum Fortfahren!",
    UNKNOWN_FIELD: "Bitte geben Sie weitere Informationen zu Ihrer Reise an."
  }
} as const;
