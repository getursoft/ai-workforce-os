/** Sprint 7.12 — customer-facing case reference IDs (e.g. "KRV-842731"). Distinct from
 * `generateLeadReference()` (conversation/conversation-completion.ts, used for Travel/HR reference
 * columns) mainly in charset: this one is voice-friendly by construction — it excludes characters that
 * are easily confused when spoken or misread (0/O, 1/I/L) — which matters here since a reference must
 * survive being SPOKEN over a live phone call, not just displayed on screen.
 */

/** 31 characters: digits 2-9 and A-Z minus I/L/O. Never derived from a DB UUID (Sprint 7.12 rule #4). */
export const REFERENCE_ID_CHARSET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export interface ReferenceIdGeneratorConfig {
  prefix: string;
  length: number;
}

export const DEFAULT_REFERENCE_ID_CONFIG: ReferenceIdGeneratorConfig = { prefix: "KRV", length: 6 };

export class ReferenceIdGenerator {
  private readonly config: ReferenceIdGeneratorConfig;

  constructor(config: Partial<ReferenceIdGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_REFERENCE_ID_CONFIG, ...config };
  }

  /** Generates one candidate — callers are responsible for uniqueness (DB unique constraint + retry on
   * collision, see InteractionService.create). A single candidate is never assumed to be unique. */
  generate(): string {
    let suffix = "";
    for (let i = 0; i < this.config.length; i++) {
      suffix += REFERENCE_ID_CHARSET[Math.floor(Math.random() * REFERENCE_ID_CHARSET.length)];
    }
    return `${this.config.prefix}-${suffix}`;
  }
}

/** Normalizes user-supplied reference text ("krv 842731", "KRV842731", " krv-842731 ") into the
 * canonical stored form ("KRV-842731") so lookups succeed regardless of how the customer typed or the
 * speech-to-text engine transcribed it. `prefixLength` must match the generator's configured prefix. */
export function normalizeReferenceId(raw: string, prefixLength: number): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length <= prefixLength) return cleaned;
  return `${cleaned.slice(0, prefixLength)}-${cleaned.slice(prefixLength)}`;
}

/** Sprint 7.12 STEP 11/45: renders a stored reference ID as a TTS-friendly spoken string — letters and
 * digits individually spaced so the voice provider pronounces each character rather than trying to read
 * "KRV" as a word or "842731" as a six-digit number. Never mutates the stored reference itself. */
export function spokenReferenceId(referenceId: string): string {
  return referenceId
    .split("")
    .filter((ch) => ch !== "-")
    .join(" ");
}
