/**
 * Sprint 6.3 — Parts 4/5/10/11: a small, employee-agnostic conversational-response policy shared by the
 * Receptionist and every AI Employee. This module never decides WHAT happened (booking status, PNR,
 * price, workflow state) — that stays entirely with each employee's own deterministic runtime. It only
 * shapes HOW an already-composed message is finally presented: stripping any internal/debug wording that
 * shouldn't reach the customer, and — for VOICE — turning web-style formatting (bullets, headers,
 * markdown emphasis) into plain, speakable prose. One shared transform, applied wherever a response is
 * about to leave the system, rather than duplicated per-employee or per-channel logic.
 *
 * Channel-aware response contract (Part 5's conceptual `{message, channel, tone, requiresUserInput,
 * attachments, actions}` shape): `ConversationalResponse` below is that contract, made concrete enough to
 * type-check and unit-test. No VOICE provider is wired up anywhere yet (none should be, per the sprint
 * brief) — this only proves the SAME underlying message can already be shaped for a future voice channel
 * without touching business logic, exactly as `formatPackageOptionsMessageForVoice` already proved for
 * Travel's package-options prompt specifically. This is the generic, employee-agnostic counterpart.
 */

export type ResponseChannel = "WEB" | "WHATSAPP" | "VOICE";

export interface ConversationalResponseAttachment {
  type: string;
  [key: string]: unknown;
}

export interface ConversationalResponseAction {
  label: string;
}

/** The channel-aware response contract described in Part 5. `message` is always the final, customer-safe
 *  text for the given `channel` — already debug-stripped, and voice-sanitized when `channel === "VOICE"`.
 *  `tone`/`requiresUserInput`/`actions` are optional metadata a caller may already know (e.g. whether the
 *  turn is waiting on a reply) — this module never infers them, it only shapes `message`. */
export interface ConversationalResponse {
  message: string;
  channel: ResponseChannel;
  tone?: "NEUTRAL" | "APOLOGETIC" | "CONFIRMATORY";
  requiresUserInput?: boolean;
  attachments?: ConversationalResponseAttachment[];
  actions?: ConversationalResponseAction[];
}

// Part 11: internal/debug wording that must never reach the customer-facing conversation, wherever it
// might leak in from (a stray template, a debug label accidentally left in a composed string, ...). This
// is a safety net, not the primary mechanism — the primary fix is simply not generating this text in the
// first place (see `handoffPresentation`'s own WEB-channel handling) — but a shared, generic strip pass
// costs nothing and catches anything that slips through any current or future composer.
// Deliberately narrow: each pattern matches only an unambiguous internal/debug marker, never a generic
// "Label: value" shape — legitimate transactional facts ("PNR: WSTVSQ", "Booking Reference: RRAUHV",
// "Total: AED 26,203") must always survive this strip untouched. Whole-line patterns remove the entire
// line (there's nothing useful left once the marker is gone); the prefix pattern only removes the matched
// prefix, keeping whatever real content follows on the same line ("Travel Employee: Your booking is
// confirmed!" -> "Your booking is confirmed!").
const DEBUG_WORDING_WHOLE_LINE_PATTERNS: RegExp[] = [
  /^connected to\s.+$/i,
  /^debug$/i,
  /^handoff id[:\s].*$/i,
  /^routing confidence[:\s].*$/i,
  /^workflow execution(?:\s+id)?[:\s].*$/i,
  /^installation id[:\s].*$/i
];
// A leading "<Name> Employee: " prefix (e.g. "Travel Employee: ...", "HR Employee: ...").
const DEBUG_WORDING_PREFIX_PATTERN = /^\s*(?:[\w.-]+\s+)?employee:\s*/i;

/** Strips any line (or line prefix) that looks like internal/debug wording (Part 11) from a customer-
 *  facing message. Safe to call on any already-composed text — a no-op when nothing matches. Never touches
 *  the SUBSTANCE of a response (facts, warnings, prices), only text that is purely internal bookkeeping. */
export function stripDebugWording(text: string): string {
  const lines = text
    .split("\n")
    .filter((line) => !DEBUG_WORDING_WHOLE_LINE_PATTERNS.some((pattern) => pattern.test(line.trim())))
    .map((line) => line.replace(DEBUG_WORDING_PREFIX_PATTERN, ""));
  // Collapse any blank-line gaps left behind by a stripped line, and trim a leading/trailing blank line.
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Turns web-style formatting into plain, speakable prose for VOICE (Part 5): no bullet/numbered-list
 *  markers, no markdown emphasis, no headings, no bare URLs, collapsed onto short sentences/paragraphs.
 *  Deliberately a structural transform only — it does not summarize or shorten the underlying content, and
 *  it never invents wording; a caller that needs a genuinely SHORTER spoken version (e.g. Travel's package
 *  options) should compose a dedicated voice variant from the same authoritative data instead, the way
 *  `formatPackageOptionsMessageForVoice` already does. This is the generic fallback for everything else. */
export function toVoiceSafeText(text: string): string {
  const withoutMarkdown = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*[•*-]\s+/, "") // bullet markers
        .replace(/^\s*\d+[.)]\s+/, "") // numbered-list markers
        .replace(/^#{1,6}\s+/, "") // markdown headings
        .replace(/\*\*(.+?)\*\*/g, "$1") // bold
        .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1") // italic
        .replace(/`([^`]+)`/g, "$1") // inline code
    )
    .filter((line) => line.trim().length > 0)
    .join(". ");
  return withoutMarkdown
    .replace(/https?:\/\/\S+/g, "") // no bare URLs when spoken
    .replace(/\s{2,}/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim();
}

/** Applies the shared policy to a raw, already-composed message and returns the channel-aware response
 *  contract (Part 5). Always strips debug wording; only VOICE gets the markdown-to-prose transform — WEB
 *  keeps its full rich formatting (Part 5: "rich formatting can remain available"), and WHATSAPP is passed
 *  through as-is beyond debug-stripping (its own composers already keep replies concise). */
export function composeChannelResponse(
  rawMessage: string,
  channel: ResponseChannel,
  extra: Omit<ConversationalResponse, "message" | "channel"> = {}
): ConversationalResponse {
  const debugFree = stripDebugWording(rawMessage);
  const message = channel === "VOICE" ? toVoiceSafeText(debugFree) : debugFree;
  return { message, channel, ...extra };
}

/** Sprint 6.4 — Part 4/5: the single place that decides which channel a turn is being shaped for. An
 *  explicit `requestedChannel` (threaded from the public `AgentRunDto.channel` field, through
 *  `AgentExecutionInput`) always wins — it's how a caller without a real WhatsApp/Voice provider behind it
 *  (a test, an admin preview, a future direct API integration) can still ask for channel-safe output
 *  through the one real endpoint. Otherwise the channel is inferred from execution provenance exactly as
 *  it already was pre-Sprint-6.4 (a real WhatsApp webhook's `source.type === "CHANNEL"`, a future voice
 *  provider's `source.type === "VOICE"`), defaulting to WEB — so an existing caller that sends neither
 *  keeps getting exactly what it always got (Part 5's backward-compatibility requirement). Shared by
 *  ReceptionistService and AgentService so the two never drift on what "the channel" means for a turn. */
export function resolveConversationChannel(input: {
  sourceType: "DASHBOARD" | "CHANNEL" | "VOICE";
  requestedChannel?: ResponseChannel | undefined;
}): ResponseChannel {
  if (input.requestedChannel) return input.requestedChannel;
  if (input.sourceType === "VOICE") return "VOICE";
  if (input.sourceType === "CHANNEL") return "WHATSAPP";
  return "WEB";
}
