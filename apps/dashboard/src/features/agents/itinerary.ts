export interface ParsedItinerary {
  intro: string;
  flights: string[];
  hotels: string[];
  itineraryDays: string[];
  footer: string[];
}

const FLIGHTS_HEADER = "Flight options:";
const HOTELS_HEADER = "Hotel options:";
const ITINERARY_HEADER = "Itinerary summary:";

/**
 * Parses the Travel Employee's recommendation message (a fixed, predictable text layout produced by
 * buildRecommendationMessage) into sections the dashboard can render as cards. Any other assistant
 * message — including LLM-generated conversational replies — simply doesn't match and falls back to
 * plain bubble text.
 */
export function parseTravelRecommendation(content: string): ParsedItinerary | null {
  if (!content.includes(FLIGHTS_HEADER) || !content.includes(HOTELS_HEADER)) return null;
  const paragraphs = content
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const result: ParsedItinerary = { intro: "", flights: [], hotels: [], itineraryDays: [], footer: [] };
  for (const paragraph of paragraphs) {
    const [first, ...rest] = paragraph.split("\n");
    if (first === FLIGHTS_HEADER) result.flights = rest.map(stripBullet).filter(Boolean);
    else if (first === HOTELS_HEADER) result.hotels = rest.map(stripBullet).filter(Boolean);
    else if (first === ITINERARY_HEADER) result.itineraryDays = rest.filter(Boolean);
    else if (!result.intro) result.intro = paragraph;
    else result.footer.push(paragraph);
  }
  return result;
}

function stripBullet(line: string): string {
  return line.replace(/^\s*\d+\.\s*/, "").trim();
}
