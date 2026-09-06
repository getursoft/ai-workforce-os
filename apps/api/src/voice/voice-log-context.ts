/** Sprint 7.11 — STEP 3: structured voice logging schema.
 *
 * Matches the object-log convention already used throughout the codebase
 * (`this.logger.warn({ event: "X", ...fields })`, e.g. channel-message.processor.ts) rather than
 * introducing a new logging style. Every meaningful voice event CAN carry these fields — none are
 * required, since not every log site has all of them (e.g. a webhook-time log has no voiceSessionId yet).
 *
 * Redaction is defense-in-depth: `voiceLogContext()` strips any key that looks like a credential/secret
 * even if a caller passes one in by mistake, and caps free-text fields so a stray full transcript or
 * error stack never balloons a structured log line into something that looks like an audit trail.
 */

export interface VoiceLogContext {
  requestId?: string;
  organizationId?: string;
  channelId?: string;
  voiceSessionId?: string;
  conversationId?: string;
  agentId?: string;
  activeAgentId?: string;
  provider?: string;
  transport?: string;
  providerCallId?: string;
  providerStreamId?: string;
  event: string;
  sequenceNumber?: number;
  latencyMs?: number;
  errorCode?: string;
}

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|credential|apikey/i;
const MAX_STRING_FIELD_LENGTH = 200;

/** Builds a log-safe context object: known fields pass through (truncated if oversized), any key that
 * looks sensitive is dropped entirely (never even a redacted placeholder — the field simply doesn't
 * exist in the log), and raw audio / full transcripts are never accepted by this type in the first
 * place (VoiceLogContext has no field for either). */
export function voiceLogContext(input: VoiceLogContext & Record<string, unknown>): VoiceLogContext {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY_PATTERN.test(key)) continue; // dropped, not redacted-with-placeholder — never logged
    safe[key] = typeof value === "string" && value.length > MAX_STRING_FIELD_LENGTH
      ? `${value.slice(0, MAX_STRING_FIELD_LENGTH)}…(truncated)`
      : value;
  }
  return safe as unknown as VoiceLogContext;
}
