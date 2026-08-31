import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider
} from "@ai-workforce-os/plugin-sdk";
import {
  extractPhoneNumber,
  formatSuggestedActions,
  isAffirmativeResponse,
  isNegativeResponse,
  type ConversationCompletionStage,
  type SuggestedAction
} from "../conversation/conversation-completion";

/**
 * Shared conversation engine for every non-Travel AI Employee (HR, Finance, IT Support, Sales, Marketing,
 * Legal, Customer Support). Travel deliberately keeps its own bespoke runtime (it is far deeper than any
 * other employee and predates this module); every future employee follows this shared contract instead so
 * the "offer -> consent -> contact -> persisted artifact" flow, the deterministic provider, and the LLM
 * orchestrator behave identically across domains — only the domain vocabulary (fields, recommendation text,
 * artifact tool name) differs, supplied by each employee's own {@link EmployeeDomainSpec}.
 */

/** The conversational stages shared by every domain employee. */
export type EmployeeStage =
  | "COLLECT_NAME"
  | "DISCOVER_INTENT"
  | "COLLECT_DETAILS"
  | "RECOMMEND"
  | "AWAITING_CONTACT"
  | "CAPTURED"
  | "ESCALATED";

/** A single domain field the employee collects (e.g. leave type, ticket category, campaign channel). */
export interface EmployeeFieldSpec {
  /** Stable storage key on {@link EmployeeEntities}. */
  key: string;
  /** Human label used in questions ("your leave type"). */
  label: string;
  /** The exact question to ask when this field is missing. */
  ask: string;
  /** Deterministic extractor; returns null when the field cannot be confidently read from the text. */
  extract: (text: string, prior: string | null) => string | null;
  /** Optional fields are only collected if the user volunteers them; never blocking. */
  optional?: boolean;
}

/** The free-form entity bag collected for a domain conversation. `customerName` is universal. */
export interface EmployeeEntities {
  customerName: string | null;
  [key: string]: string | number | null;
}

/** Persistent per-conversation bookkeeping (mirrors the travel memory's conversation-completion fields). */
export interface EmployeeConversationMemory {
  completionStage: ConversationCompletionStage;
  /** Set while a phone/email reply is being awaited for artifact capture. */
  pendingContactValue: string | null;
  conversationClosed: boolean;
  /** Reference of the artifact persisted for this conversation, if any. */
  capturedReference: string | null;
  /** The last domain field the assistant asked about, for short-answer disambiguation. */
  lastAskedField: string | null;
  /** Whether the "would you like to submit this?" offer has already been shown. */
  artifactOfferShown: boolean;
  /** Whether the user declined the artifact offer — never offered again. */
  declinedArtifact: boolean;
  /** Whether the "Good morning, <name>! What can I help you with?" intent-discovery menu has been shown
   *  after the customer's name was captured (mirrors the Travel employee's intent-discovery step). */
  intentDiscovered: boolean;
}

export const EMPTY_EMPLOYEE_ENTITIES: EmployeeEntities = { customerName: null };

export const EMPTY_EMPLOYEE_CONVERSATION_MEMORY: EmployeeConversationMemory = {
  completionStage: "NOT_OFFERED",
  pendingContactValue: null,
  conversationClosed: false,
  capturedReference: null,
  lastAskedField: null,
  artifactOfferShown: false,
  declinedArtifact: false,
  intentDiscovered: false
};

/** Runtime configuration shared by every domain employee (a strict subset of the travel config). */
export interface EmployeeRuntimeConfig {
  persona: string;
  welcomeMessage: string;
  escalationContact: string;
  brandTone: string;
  defaultCurrency: string;
  defaultLanguage: string;
  businessHoursStart: string | null;
  businessHoursEnd: string | null;
  businessHoursTimezone: string | null;
  /** Default jurisdiction/country for legal queries (Legal Employee) — e.g. "India". */
  defaultCountry?: string;
}

/**
 * The domain-specific contract each employee supplies. Everything generic — stage machine, name gate,
 * consent/contact capture, escalation, persistence shape — lives here and is shared; only the vocabulary
 * and artifact tool differ per employee.
 */
export interface EmployeeDomainSpec {
  /** Plugin slug, e.g. "hr-employee". */
  slug: string;
  /** AgentMemory key under which conversation state is persisted. */
  memoryKey: string;
  /** Provider string used in AiCompletionResult telemetry. */
  providerName: string;
  /** Model string used in AiCompletionResult telemetry. */
  modelName: string;
  /** Reference prefix for persisted artifacts, e.g. "HRT". */
  referencePrefix: string;
  /** The tool that persists this domain's artifact (e.g. "hr.create_ticket"). */
  artifactToolName: string;
  /** Human noun for the artifact ("HR request", "support ticket"). */
  artifactNoun: string;
  /** Default escalation contact. */
  escalationContact: string;
  /** Domain fields collected after the customer's name. Order defines the ask sequence. */
  fields: EmployeeFieldSpec[];
  /** Optional deterministic intent detection — a short phrase summarizing the user's ask, or null. */
  detectIntent?: (text: string) => string | null;
  /** Optional context line injected into the LLM extraction prompt. */
  intentHint?: string;
  /** Builds the recommendation/answer shown once all required fields are collected. */
  buildRecommendation: (entities: EmployeeEntities, memory: EmployeeConversationMemory) => string;
  /** Builds the persisted conversation summary for the artifact row. */
  buildSummary: (entities: EmployeeEntities) => string;
  /** Suggested-actions menu appended to the recommendation (optional). */
  suggestedActions?: () => readonly SuggestedAction[];
  /** Suggested actions to show during name collection (optional). */
  openingActions?: () => readonly SuggestedAction[];
  /** Direct informational answers for the most common in-scope questions, checked before the field
   *  collection flow. A matching pattern plus a question-like signal yields a domain-specific reply
   *  immediately (no name gate) — this is what makes each employee answer in its own domain's terms. */
  infoAnswers?: readonly { pattern: RegExp; answer: string }[];
}

/** Cross-employee routing profile: which keywords belong to which AI Employee. Used to detect when a
 *  message clearly belongs to a different employee than the one currently handling the conversation, so
 *  the employee can say "that's out of my scope — I'll route you to the correct employee." */
export interface EmployeeScopeProfile {
  slug: string;
  displayName: string;
  keywords: readonly string[];
}

/** Sprint 6.4 — Part 2: `plugins/<slug>/plugin.json`'s `routing.keywords` is the single authoritative
 *  source for both Receptionist routing (seeded into the tenant-scoped `EmployeeRoutingProfile` DB row by
 *  `PluginService.ensureRoutingProfile`) and this specialist-side out-of-scope detector — adding a keyword
 *  to one manifest's `routing.keywords` is enough for both consumers to see it, with no second file to
 *  edit. Read synchronously, once, at module load: `detectOutOfScopeEmployee` runs on every specialist
 *  turn and must stay a plain synchronous function (no DI, no per-turn I/O), and the manifests themselves
 *  are static repo files, not tenant data, so a one-time read at startup is safe and correct — a tenant's
 *  own customized keywords (Part 3's reconciliation) live only in the DB-backed `EmployeeRoutingProfile`
 *  and are consumed by Receptionist routing, never by this in-process specialist check. Mirrors the same
 *  `plugins/` directory resolution `PluginDiscovery` uses (see plugin.module.ts). */
function loadEmployeeScopeProfilesFromManifests(): readonly EmployeeScopeProfile[] {
  const baseDirectory = resolve(__dirname, "../../../../plugins");
  try {
    const profiles: EmployeeScopeProfile[] = [];
    for (const entry of readdirSync(baseDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          readFileSync(resolve(baseDirectory, entry.name, "plugin.json"), "utf8")
        ) as {
          id?: string;
          displayName?: string;
          routing?: { keywords?: unknown };
        };
        const keywords = manifest.routing?.keywords;
        if (
          !manifest.id ||
          !manifest.displayName ||
          !Array.isArray(keywords) ||
          keywords.length === 0
        )
          continue;
        profiles.push({
          slug: manifest.id,
          displayName: manifest.displayName,
          keywords: keywords.filter((k): k is string => typeof k === "string")
        });
      } catch {
        // A plugin without a manifest, or without a routing block, simply doesn't participate in
        // cross-employee scope detection — the same graceful degradation PluginDiscovery applies to
        // individually broken plugin directories.
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

export const EMPLOYEE_SCOPE_PROFILES: readonly EmployeeScopeProfile[] =
  loadEmployeeScopeProfilesFromManifests();

/** Returns the profile for a plugin slug, or null. */
export function employeeScopeProfile(slug: string): EmployeeScopeProfile | null {
  return EMPLOYEE_SCOPE_PROFILES.find((profile) => profile.slug === slug) ?? null;
}

const QUESTION_LIKE_PATTERN =
  /\b(?:what|how|when|where|which|can|could|should|tell\s+me|explain|i\s+want|i\s+need|is\s+there|do\s+you|does|why)\b/i;

/** Detects whether the user's message clearly belongs to a DIFFERENT employee than the one handling the
 *  conversation. Returns the target employee's slug when the message's strongest keyword signal is another
 *  domain's (and not the current one's) — the current employee then routes instead of answering. Explicit
 *  mentions of another employee by name/team always win, and domain-intent keywords (reimbursement, claim,
 *  refund, invoice, leave, ...) count toward the owning employee. */
export function detectOutOfScopeEmployee(
  spec: EmployeeDomainSpec,
  text: string,
  /** Sprint 6.4 — Part 10: this employee's own most recent reply, if any (null/omitted when it hasn't
   *  spoken yet). See the `contextEcho` check below. */
  recentOwnMessage?: string | null
): EmployeeScopeProfile | null {
  const lower = text.toLowerCase();
  if (!text.trim() || /^\s*(yes|no|ok|sure|thanks|thank you|ji|haan|nahi)\b/i.test(lower)) return null;

  // Explicit mention of another employee by name/team ("HR employee", "sales team", "finance wale",
  // "hr ka kaam", ...) is the strongest possible routing signal — honor it even when no other keyword fits.
  const explicit = explicitEmployeeMention(spec, lower);
  if (explicit) return explicit;

  const own = employeeScopeProfile(spec.slug);
  const ownHits = own ? own.keywords.filter((keyword) => scopeKeywordMatches(keyword, lower)).length : 0;
  let best: EmployeeScopeProfile | null = null;
  let bestHits = 0;
  for (const profile of EMPLOYEE_SCOPE_PROFILES) {
    if (profile.slug === spec.slug) continue;
    const hits = profile.keywords.filter((keyword) => scopeKeywordMatches(keyword, lower)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = profile;
    }
  }
  // Route only when another domain's signal is strictly stronger than this employee's own — so an
  // in-scope question that merely mentions a foreign word (e.g. a legal notice mentioning "tax") never
  // gets misrouted away.
  if (!best || bestHits === 0 || bestHits <= ownHits) return null;
  // Fix (Sprint 6.4 — Part 10): a bare single-keyword match ("budget", "invoice") scores identically
  // whether it's a genuine cross-domain request or an ordinary in-context reply to something THIS employee
  // itself just asked about ("...your approximate budget?" -> "budget 10000 AED") — live-verified: Travel
  // asks about budget, the traveler answers, and without this check the answer alone outscores Travel's
  // own (budget-free) keyword list and gets bounced to Finance. Mirrors the Receptionist layer's own
  // `contextEcho` guard (receptionist-routing.service.ts): if the candidate target's vocabulary ALSO
  // matches what this employee's own last message said, the word is almost certainly explained by the
  // ongoing conversation, not a pivot, so the bounce is suppressed.
  const contextEcho =
    recentOwnMessage != null &&
    best.keywords.some((keyword) => scopeKeywordMatches(keyword, recentOwnMessage.toLowerCase()));
  return contextEcho ? null : best;
}

/** Word-boundary-aware keyword match: a keyword matches only when it appears as a whole word (or a whole
 *  leading word of a longer phrase). This prevents substring false positives like "ad" inside "adults" or
 *  "it" inside "submit" from hijacking routing. Multi-word keywords match when the full phrase appears. */
function scopeKeywordMatches(keyword: string, lower: string): boolean {
  const phrase = keyword.trim().toLowerCase();
  if (!phrase) return false;
  if (phrase.includes(" ")) return lower.includes(phrase);
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`).test(lower);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a message that names another AI Employee outright (e.g. "this is HR's job", "ask the finance
 *  team", "sales employee"). Used by {@link detectOutOfScopeEmployee} as the strongest routing signal.
 *  Deliberately specific: a bare domain noun like "sales" or "it" only counts when it clearly refers to
 *  the employee/team/work ("sales team", "hr employee", "finance wale"), never when it's an incidental
 *  word in another context ("sales trip", "it is", "travel it"). */
const EXPLICIT_EMPLOYEE_MENTIONS: ReadonlyArray<{ pattern: RegExp; slug: string }> = [
  { pattern: /\b(hr|human\s?resources?)\s+(employee|team|department|wale|wala|ka\s+kaam|ko\s+route|se\s+bat|se\s+help)\b|\bhr\s+ka\s+kaam\b|\bhr\s+wale\b/i, slug: "hr-employee" },
  { pattern: /\b(finance|accounts?|accounting)\s+(employee|team|department|wale|wala|ka\s+kaam|ko\s+route|se\s+bat|se\s+help)\b|\bfinance\s+ka\s+kaam\b|\bfinance\s+wale\b/i, slug: "finance-employee" },
  { pattern: /\b(it|tech|helpdesk)\s+(support|team|employee|department|wale|wala)\b|\bit\s+support\b|\bhelpdesk\b/i, slug: "it-support-employee" },
  { pattern: /\bsales\s+(team|employee|department|wale|wala|person|rep)\b|\bsales\s+ka\s+kaam\b|\bcrm\s+team\b/i, slug: "sales-employee" },
  { pattern: /\bmarketing\s+(team|employee|department|wale|wala)\b/i, slug: "marketing-employee" },
  { pattern: /\blegal\s+(team|employee|department|wale|wala)\b|\badvocate\b|\blawyer\b/i, slug: "legal-employee" },
  { pattern: /\bcustomer\s?support\s+(team|employee|department)\b|\bsupport\s+team\b|\bsupport\s+employee\b/i, slug: "customer-support-employee" },
  { pattern: /\btravel\s+(team|employee|department|wale|wala)\b|\btrip\s+planning\s+team\b/i, slug: "travel-employee" }
];

function explicitEmployeeMention(
  spec: EmployeeDomainSpec,
  lower: string
): EmployeeScopeProfile | null {
  for (const mention of EXPLICIT_EMPLOYEE_MENTIONS) {
    if (mention.slug === spec.slug) continue;
    if (mention.pattern.test(lower)) {
      const profile = employeeScopeProfile(mention.slug);
      if (profile) return profile;
    }
  }
  return null;
}

/** Builds the out-of-scope routing reply. */
export function buildOutOfScopeRoutingMessage(
  spec: EmployeeDomainSpec,
  target: EmployeeScopeProfile
): string {
  return [
    `That's outside my scope as the ${spec.artifactNoun} assistant.`,
    `It looks like this belongs to the ${target.displayName}.`,
    "I'll route your request to the correct employee so you get the right help."
  ].join("\n");
}

/** The "belongs to the X." line from {@link buildOutOfScopeRoutingMessage} — matched back out of the
 *  prior assistant turn by {@link detectRoutingConfirmation} to recover which employee was offered. */
const ROUTING_OFFER_TARGET_PATTERN = /belongs to the (.+?)\./;

const ROUTING_CONFIRMATION_PATTERN = /\broute\s*(it|this|me|to)?\b/i;

/** What a confirmed cross-employee routing handoff needs: which employee to hand off to, and the
 *  ORIGINAL out-of-scope message (never the "yes" itself) to carry over as that conversation's opener. */
export interface RoutingHandoffSignal {
  targetSlug: string;
  originalText: string;
}

/** Detects a user's confirmation of a routing offer made by {@link buildOutOfScopeRoutingMessage} on the
 *  immediately preceding assistant turn ("yes", "sure", "route it", ...). Returns the target employee and
 *  the message from BEFORE the offer — the thing that actually needs to be handed off — so the caller
 *  (AgentService, which owns Prisma/conversation creation) can act on it. Returns null for an ordinary
 *  reply, a routing offer that was never made, or a decline. */
export function detectRoutingConfirmation(
  spec: EmployeeDomainSpec,
  messages: ReadonlyArray<{ role: string; content: string }>
): { target: EmployeeScopeProfile; originalText: string } | null {
  const last = messages.at(-1);
  if (!last || last.role !== "user") return null;
  const text = last.content.trim();
  if (!text || isNegativeResponse(text)) return null;
  if (!isAffirmativeResponse(text) && !ROUTING_CONFIRMATION_PATTERN.test(text)) return null;

  const priorAssistant = messages.at(-2);
  if (!priorAssistant || priorAssistant.role !== "assistant") return null;
  if (!priorAssistant.content.includes("I'll route your request to the correct employee")) return null;
  const displayName = priorAssistant.content.match(ROUTING_OFFER_TARGET_PATTERN)?.[1]?.trim();
  if (!displayName) return null;
  const target = EMPLOYEE_SCOPE_PROFILES.find(
    (profile) => profile.displayName === displayName && profile.slug !== spec.slug
  );
  if (!target) return null;

  const priorUser = messages.at(-3);
  const originalText = priorUser && priorUser.role === "user" ? priorUser.content : text;
  return { target, originalText };
}

/** Whether the message reads like a real question (used to gate direct info answers so a bare field
 *  reply during collection is never mistaken for an out-of-scope or informational ask). */
export function looksLikeAQuestion(text: string): boolean {
  return QUESTION_LIKE_PATTERN.test(text) || text.trim().split(/\s+/).length >= 4;
}

/** Parses the `[Attachment: filename (mimeType)]` blocks that AgentService prepends to a message when the
 *  user uploaded files. Each block's content is the extracted text of that file. */
export function parseAttachmentBlocks(text: string): Array<{ filename: string; mimeType: string; content: string }> {
  const blocks: Array<{ filename: string; mimeType: string; content: string }> = [];
  const pattern = /\[Attachment:\s+([^\]]+)\]\s*([\s\S]*?)(?=\n\n\[Attachment:|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const header = match[1]?.trim() ?? "file";
    const content = (match[2] ?? "").trim();
    const filename = header.split("(")[0]?.trim() ?? "file";
    const mimeType = header.includes("(") ? header.slice(header.indexOf("(") + 1, header.lastIndexOf(")")) ?? "" : "";
    blocks.push({ filename, mimeType, content });
  }
  return blocks;
}

/** Builds the response when a document is attached: the employee reads the extracted text, states what the
 *  document is about (its intent), and then says whether it is related to this employee's domain or
 *  belongs to a different employee — offering to help if it's in scope, or to route it if it isn't. */
export function buildAttachmentReadMessage(
  spec: EmployeeDomainSpec,
  blocks: Array<{ filename: string; mimeType: string; content: string }>
): string {
  const names = blocks.map((block) => block.filename);
  const joined = blocks.map((block) => block.content).join("\n").trim();
  const intent = summarizeAttachmentText(joined);
  const ownProfile = employeeScopeProfile(spec.slug);
  const ownDomain = ownProfile?.displayName ?? "my team";
  const outOfScopeTarget = detectOutOfScopeEmployee(spec, joined);
  if (outOfScopeTarget) {
    return [
      `I've read your attached document${blocks.length > 1 ? "s" : ""}: ${names.join(", ")}.`,
      "",
      `${intent}`,
      "",
      `This document looks like it's about ${outOfScopeTarget.displayName} matters, which isn't my area (${ownDomain}).`,
      "If you'd like, I can route it to the relevant employee so they can help you with it."
    ].join("\n");
  }
  return [
    `I've read your attached document${blocks.length > 1 ? "s" : ""}: ${names.join(", ")}.`,
    "",
    `${intent}`,
    "",
    `This document is related to ${ownDomain}. If you need any ${ownDomain.toLowerCase()} information or help, I'm happy to assist — just tell me what you'd like to do.`,
    "If it's not relevant to me, let me know and I'll route it to the correct employee."
  ].join("\n");
}

/** Produces a short, factual "what the document is about" statement from the extracted text — the first few
 *  meaningful sentences, never an invention beyond what the file actually contained. */
export function summarizeAttachmentText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "The document's text couldn't be read — it may be an image-only or scanned file.";
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean];
  const preview = sentences.slice(0, 3).join(" ").trim();
  const short = preview.length > 280 ? `${preview.slice(0, 280).trim()}…` : preview;
  return `It looks like this document is about: ${short}`;
}



const ESCALATION_PATTERN =
  /\b(?:talk\s+to\s+(?:a\s+)?(?:human|person|agent|manager|representative)|speak\s+(?:to|with)\s+(?:a\s+)?(?:human|person|agent|manager)|human\s+agent|transfer\s+me|escalat(e|ion)|contact\s+(?:a\s+)?(?:human|agent)|real\s+(?:human|person)\b|(?:mujhe|humein)\s+(?:insaan|human|agent)\s+se\s+baat|baat\s+karna\s+hai)/i;

export function isEmployeeEscalationRequest(text: string): boolean {
  return ESCALATION_PATTERN.test(text);
}

const CUSTOMER_NAME_PATTERN =
  /\b(?:my\s+name\s+is|i\s+am|i'm|call\s+me|myself|name\s+hai|naam|mera\s+naam)\s+([a-z][a-z\s.'-]{1,40})/i;

export function extractEmployeeName(text: string): string | null {
  const match = text.match(CUSTOMER_NAME_PATTERN);
  if (!match) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    // A bare name reply ("Priya", "Priya Sharma") is accepted as the customer name.
    if (words.length >= 1 && words.length <= 3) {
      const candidate = words.join(" ");
      if (/^[A-Za-z][A-Za-z.'-]+$/.test(candidate)) return candidate;
    }
    return null;
  }
  const captured = match[1];
  return captured ? captured.trim() : null;
}

/** Builds the "may I know your name?" message for a given domain. */
export function buildEmployeeNameRequest(spec: EmployeeDomainSpec): string {
  const actions = spec.openingActions?.() ?? [];
  return [
    "Hi \u{1F44B}, thank you for reaching out!",
    "May I know your name, please?",
    ...(actions.length ? formatSuggestedActions(actions, "You can ask me about:").split("\n").filter(Boolean) : [])
  ].join("\n");
}

/** Builds the "what would you like help with?" message. */
export function buildEmployeeIntentRequest(spec: EmployeeDomainSpec): string {
  const actions = spec.openingActions?.() ?? [];
  return [
    `Thanks! What would you like help with today?`,
    ...(actions.length ? formatSuggestedActions(actions).split("\n").filter(Boolean) : [])
  ].join("\n");
}

/** Time-of-day greeting word — matches the Travel employee's template. Uses server time. */
export function timeOfDayGreeting(now: Date = new Date()): "Good morning" | "Good afternoon" | "Good evening" {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Builds the intent-discovery message shown right after the customer's name is captured, personalised
 *  with this employee's domain options.
 *
 *  Sprint 6.3 — Part 4: the previous version ("Good morning, X! Nice to meet you. How may I help you
 *  today? I can help you: • ... Tell me what you'd like to do and I'll take it from there.") read like a
 *  form — a redundant "Nice to meet you" filler line, the same question asked twice in different words
 *  ("How may I help you today?" immediately followed by "I can help you:"), and a closing line that
 *  restates the opening question again. This keeps the SAME information (a short greeting plus a genuine
 *  menu of concrete starting points, which Part 10 explicitly allows for — a real menu of distinct
 *  actionable choices is useful, not "excessive") in one pass, asked once. */
export function buildEmployeeIntentDiscoveryMessage(spec: EmployeeDomainSpec, name: string, now: Date = new Date()): string {
  const greeting = timeOfDayGreeting(now);
  const actions = spec.openingActions?.() ?? [];
  const firstName = name.split(" ")[0] ?? name;
  const lines = [`${greeting}, ${firstName}! \u{1F44B} What can I help you with?`];
  if (actions.length) {
    lines.push("");
    for (const action of actions) lines.push(`• ${action.label}`);
  }
  return lines.join("\n");
}

/** Sprint 6.3 — Part 5/15: a VOICE-channel presentation of the SAME intent-discovery data
 *  `buildEmployeeIntentDiscoveryMessage` renders for WEB/WHATSAPP — same underlying options, never a
 *  different or invented set — only the presentation differs: no bullet list, one short spoken sentence
 *  naming a couple of examples and inviting the customer to say what they need, rather than reciting every
 *  option up front. Mirrors Travel's `formatPackageOptionsMessageForVoice` for the same reason. */
export function buildEmployeeIntentDiscoveryMessageForVoice(
  spec: EmployeeDomainSpec,
  name: string,
  now: Date = new Date()
): string {
  const greeting = timeOfDayGreeting(now);
  const actions = spec.openingActions?.() ?? [];
  const firstName = name.split(" ")[0] ?? name;
  if (!actions.length) return `${greeting}, ${firstName}! What can I help you with?`;
  const examples = actions
    .slice(0, 2)
    .map((action) => action.label.replace(/[.?!]$/, "").toLowerCase())
    .join(" or ");
  return `${greeting}, ${firstName}! I can help with things like ${examples}, or whatever else you need — what would you like to do?`;
}

/** Builds the escalation handoff message. */
export function buildEmployeeEscalationMessage(spec: EmployeeDomainSpec, contact: string | null): string {
  const lines = [
    `I've escalated this to a member of our ${spec.artifactNoun} team so they can help you directly.`
  ];
  if (contact) lines.push(`You can also reach them at ${contact}.`);
  return lines.join("\n");
}

/** Builds the consent/contact request shown after a recommendation is accepted. */
export function buildEmployeeContactRequestMessage(spec: EmployeeDomainSpec): string {
  return [
    `To create your ${spec.artifactNoun}, could you share a phone number (or email) and confirm I may use it for follow-up?`
  ].join("\n");
}

/** Builds the message confirming an artifact was persisted. */
export function buildEmployeeArtifactCapturedMessage(spec: EmployeeDomainSpec, reference: string): string {
  return [
    `Your ${spec.artifactNoun} has been created successfully.`,
    "",
    `Reference: ${reference}`,
    "",
    "Our team will follow up on it. Is there anything else I can help you with?"
  ].join("\n");
}
/**
 * Deterministic, code-driven conversation engine shared by every domain employee. Runs through the same
 * AiProvider contract and tool-calling loop as any other AI employee. It collects the customer name,
 * discovers intent, collects the domain's required fields, produces the domain's recommendation, and offers
 * the "offer -> consent -> contact -> persisted artifact" flow. It never claims an external action occurred.
 */
export class EmployeeDomainProvider implements AiProvider {
  private memory: EmployeeConversationMemory;
  private entities: EmployeeEntities;
  private readonly spec: EmployeeDomainSpec;
  private readonly config: EmployeeRuntimeConfig;
  private static toolSequence = 0;
  /** True when the most recent `complete()` returned a *structured decision* (attachment read, out-of-scope
   *  routing, escalation, or direct info answer) rather than an ordinary conversational reply — used by the
   *  LLM orchestrator to avoid rewriting such replies through the real provider and losing their intent. */
  private structuredReply = false;
  /** Non-null only the turn a routing offer (see {@link buildOutOfScopeRoutingMessage}) was just confirmed.
   *  This pure engine has no Prisma access to actually create the handoff conversation — AgentService reads
   *  this once per turn (mirrors the Travel Runtime `lastWorkflowSignal` convention) and does the real work,
   *  rewriting this turn's already-persisted response once it knows the outcome. Reset every `complete()`. */
  private routingHandoffSignal: RoutingHandoffSignal | null = null;

  constructor(
    spec: EmployeeDomainSpec,
    config: EmployeeRuntimeConfig,
    priorMemory: EmployeeConversationMemory = EMPTY_EMPLOYEE_CONVERSATION_MEMORY,
    priorEntities: EmployeeEntities = EMPTY_EMPLOYEE_ENTITIES
  ) {
    this.spec = spec;
    this.config = config;
    this.memory = { ...priorMemory };
    this.entities = { ...priorEntities };
  }

  get lastMemory(): EmployeeConversationMemory {
    return this.memory;
  }

  get lastEntities(): EmployeeEntities {
    return this.entities;
  }

  /** Syncs the inner deterministic engine's entity bag with an external source (e.g. the LLM orchestrator's
   *  extraction) so both engines always agree on the persisted state. */
  syncEntities(entities: EmployeeEntities): void {
    this.entities = { ...entities };
  }

  /** True when the most recent turn was a structured decision (attachment read / out-of-scope routing /
   *  escalation / info answer) that must not be rewritten by an LLM orchestrator. */
  get lastWasStructuredReply(): boolean {
    return this.structuredReply;
  }

  get lastRoutingHandoffSignal(): RoutingHandoffSignal | null {
    return this.routingHandoffSignal;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.structuredReply = false;
    this.routingHandoffSignal = null;
    const messages = request.messages;
    const last = messages.at(-1);
    const userMessages = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    const currentText = userMessages.at(-1) ?? "";

    // Tool continuation: the artifact was just persisted (or the user declined / we escalated).
    if (last?.role === "tool") return this.continueAfterTool(last);

    // Escalation is always honored, at any point.
    if (isEmployeeEscalationRequest(currentText)) {
      this.structuredReply = true;
      this.memory = { ...this.memory, conversationClosed: true, completionStage: "DECLINED" };
      return this.toolResult(`${this.spec.slug}.escalate`, {
        reason: currentText.slice(0, 500)
      });
    }

    // Attached document: when the user uploaded a file, the extracted text arrives as `[Attachment: ...]`
    // blocks. Read the document, summarise what it's about, and route it if it belongs to a different
    // employee's domain — instead of treating the file's text as ordinary conversation. Only when there is
    // no active contact-capture or captured artifact, so a mid-flow reply is never hijacked.
    const attachmentBlocks = parseAttachmentBlocks(currentText);
    const isCapturingContact =
      this.memory.completionStage === "AWAITING_CONTACT" ||
      this.memory.completionStage === "CAPTURED" ||
      this.memory.completionStage === "DECLINED";
    if (attachmentBlocks.length > 0 && !isCapturingContact) {
      this.structuredReply = true;
      this.memory = { ...this.memory, lastAskedField: null };
      return this.textResult(buildAttachmentReadMessage(this.spec, attachmentBlocks));
    }

    // Cross-employee routing confirmation: the immediately preceding turn offered to route an out-of-scope
    // message elsewhere, and this reply accepts it ("yes", "route it", ...). See lastRoutingHandoffSignal.
    if (!isCapturingContact) {
      const confirmation = detectRoutingConfirmation(this.spec, messages);
      if (confirmation) {
        this.structuredReply = true;
        this.memory = { ...this.memory, lastAskedField: null };
        this.routingHandoffSignal = {
          targetSlug: confirmation.target.slug,
          originalText: confirmation.originalText
        };
        return this.textResult(`Connecting you to ${confirmation.target.displayName}…`);
      }
    }

    // Cross-employee routing: a message clearly belonging to a different employee's domain (and not this
    // one's) is answered with an out-of-scope + routing reply instead of being collected into this
    // employee's own artifact flow. Never interrupts an active contact-capture (awaiting phone/email) or a
    // conversation that has already captured an artifact.
    if (!isCapturingContact) {
      // Both routing and info answers only fire when we are NOT mid-field-collection: once a field has
      // been asked, the user's reply is a field answer, not a new out-of-scope or informational ask.
      const notMidCollection = this.memory.lastAskedField === null;
      const recentOwnMessage =
        [...messages].reverse().find((message) => message.role === "assistant")?.content ?? null;
      const outOfScopeTarget = notMidCollection
        ? detectOutOfScopeEmployee(this.spec, currentText, recentOwnMessage)
        : null;
      if (outOfScopeTarget) {
        this.structuredReply = true;
        this.memory = { ...this.memory, lastAskedField: null };
        return this.textResult(buildOutOfScopeRoutingMessage(this.spec, outOfScopeTarget));
      }
      // Direct in-scope informational answer (no name gate) — a common domain question ("what is the leave
      // policy?") gets a domain-specific reply immediately instead of being funneled into field collection.
      // Only before intent discovery: once the customer has started describing their request (name captured
      // + intent menu shown), a topic-like reply is a field answer, not a standalone question.
      const infoAnswer =
        notMidCollection && !this.memory.intentDiscovered
          ? this.resolveInfoAnswer(currentText)
          : null;
      if (infoAnswer) {
        this.structuredReply = true;
        this.memory = { ...this.memory, artifactOfferShown: false };
        return this.textResult(infoAnswer);
      }
    }

    // Awaiting a phone/email after the artifact offer was accepted.
    if (this.memory.completionStage === "AWAITING_CONTACT") {
      if (isNegativeResponse(currentText)) {
        this.memory = { ...this.memory, completionStage: "DECLINED", pendingContactValue: null };
        return this.textResult(
          "No problem — your details are noted. Just ask if you'd like to submit it later!"
        );
      }
      const phone = extractPhoneNumber(currentText);
      if (phone) {
        this.memory = { ...this.memory, pendingContactValue: phone };
        return this.toolResult(this.spec.artifactToolName, this.buildArtifactPayload(phone));
      }
      if (/@/.test(currentText)) {
        const email = currentText.trim().slice(0, 160);
        this.memory = { ...this.memory, pendingContactValue: email };
        return this.toolResult(this.spec.artifactToolName, this.buildArtifactPayload(email));
      }
      return this.textResult(buildEmployeeContactRequestMessage(this.spec));
    }

    // Name gate.
    if (!this.entities.customerName) {
      const name = extractEmployeeName(currentText);
      if (!name) {
        this.structuredReply = true;
        return this.textResult(buildEmployeeNameRequest(this.spec));
      }
      this.entities = { ...this.entities, customerName: name };
      // After capturing the name, show the intent-discovery menu (same template as the Travel employee) —
      // unless the very same message already names a concrete topic (the domain's topic field, never the
      // catch-all details/description field which matches any text). A bare "Krishna" or "my name is X"
      // always gets the menu; "I want an email campaign" skips straight to field collection.
      const topicField = this.spec.fields.find((field) => !field.optional);
      const hasTopicAlready = topicField ? topicField.extract(currentText, null) !== null : false;
      if (!hasTopicAlready && !this.memory.intentDiscovered) {
        this.structuredReply = true;
        this.memory = { ...this.memory, intentDiscovered: true, lastAskedField: null };
        const captured = this.entities.customerName;
        return this.textResult(
          buildEmployeeIntentDiscoveryMessage(this.spec, typeof captured === "string" ? captured : "")
        );
      }
      if (this.memory.completionStage === "NOT_OFFERED" && this.missingRequiredFields().length === 0)
        return this.produceRecommendation();
    }
    // Intent-discovery gate: the name is known but the customer has not yet told us what they want — keep
    // offering the menu (mirrors Travel's intent-discovery step) until they give a topic or answer.
    const topicField = this.spec.fields.find((field) => !field.optional);
    const hasTopicValue =
      (topicField && this.entityValue(topicField.key) !== null) ||
      (topicField ? topicField.extract(currentText, null) !== null : false);
    if (
      !this.memory.intentDiscovered &&
      this.memory.lastAskedField === null &&
      this.missingRequiredFields().length > 0 &&
      !hasTopicValue
    ) {
      this.structuredReply = true;
      this.memory = { ...this.memory, intentDiscovered: true, lastAskedField: null };
      return this.textResult(
        buildEmployeeIntentDiscoveryMessage(this.spec, this.entities.customerName ?? "")
      );
    }

    // After the recommendation, the artifact offer.
    if (this.memory.completionStage === "OFFERED" && !this.memory.declinedArtifact) {
      if (isAffirmativeResponse(currentText)) {
        this.memory = { ...this.memory, completionStage: "AWAITING_CONTACT" };
        return this.textResult(buildEmployeeContactRequestMessage(this.spec));
      }
      if (isNegativeResponse(currentText)) {
        this.memory = { ...this.memory, completionStage: "DECLINED", declinedArtifact: true };
        return this.textResult(
          "Understood — I won't submit it. Let me know if you change your mind or need anything else!"
        );
      }
    }

    // Collect missing required domain fields.
    const missing = this.missingRequiredFields();
    const firstMissing = missing[0];
    if (firstMissing) {
      const extracted = firstMissing.extract(currentText, this.entityValue(firstMissing.key));
      if (extracted) {
        this.entities = { ...this.entities, [firstMissing.key]: extracted };
        this.memory = { ...this.memory, lastAskedField: firstMissing.key };
        const stillMissing = this.missingRequiredFields()[0];
        if (!stillMissing) return this.produceRecommendation();
        return this.textResult(stillMissing.ask);
      }
      this.memory = { ...this.memory, lastAskedField: firstMissing.key };
      return this.textResult(firstMissing.ask);
    }

    // Optional fields: capture anything volunteered, then move on.
    for (const field of this.spec.fields) {
      if (!field.optional) continue;
      if (this.entityValue(field.key) !== null) continue;
      const extracted = field.extract(currentText, null);
      if (extracted) this.entities = { ...this.entities, [field.key]: extracted };
    }

    return this.produceRecommendation();
  }

  private produceRecommendation(): AiCompletionResult {
    const recommendation = this.spec.buildRecommendation(this.entities, this.memory);
    const actions = this.spec.suggestedActions?.() ?? [];
    const withActions = recommendation + formatSuggestedActions(actions);
    if (this.memory.completionStage === "NOT_OFFERED" || this.memory.completionStage === "OFFERED") {
      this.memory = { ...this.memory, artifactOfferShown: true, completionStage: "OFFERED" };
      return this.textResult(
        `${withActions}\n\nWould you like me to submit this as a ${this.spec.artifactNoun}?`
      );
    }
    return this.textResult(withActions);
  }

  private entityValue(key: string): string | null {
    const value = this.entities[key];
    return typeof value === "string" ? value : null;
  }

  /** Returns a direct informational answer when the current message matches one of the domain's
   *  {@link infoAnswers} patterns and reads like a question. Never fires for bare field replies during
   *  collection (guarded by `looksLikeAQuestion`). */
  private resolveInfoAnswer(text: string): string | null {
    if (!looksLikeAQuestion(text)) return null;
    const answers = this.spec.infoAnswers ?? [];
    for (const entry of answers) {
      if (entry.pattern.test(text)) return entry.answer;
    }
    return null;
  }

  private missingRequiredFields(): EmployeeFieldSpec[] {
    return this.spec.fields.filter(
      (field) => !field.optional && this.entityValue(field.key) === null
    );
  }

  private buildArtifactPayload(contact: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      customerName: this.entities.customerName,
      phoneNumber: contact,
      conversationSummary: this.spec.buildSummary(this.entities)
    };
    for (const field of this.spec.fields) {
      const value = this.entityValue(field.key);
      if (value !== null) payload[field.key] = value;
    }
    return payload;
  }

  private continueAfterTool(last: AiMessage): AiCompletionResult {
    let output: Record<string, unknown> = {};
    try {
      output = JSON.parse(last.content) as Record<string, unknown>;
    } catch {
      output = {};
    }
    const reference = typeof output.reference === "string" ? output.reference : null;
    if (reference) {
      this.memory = {
        ...this.memory,
        completionStage: "CAPTURED",
        capturedReference: reference,
        pendingContactValue: null,
        conversationClosed: false
      };
      return this.textResult(buildEmployeeArtifactCapturedMessage(this.spec, reference));
    }
    if (typeof output.escalated === "boolean") {
      return this.textResult(
        buildEmployeeEscalationMessage(
          this.spec,
          typeof output.contact === "string" && output.contact
            ? output.contact
            : this.config.escalationContact
        )
      );
    }
    return this.textResult("Thanks! Is there anything else I can help you with?");
  }

  private textResult(content: string): AiCompletionResult {
    const tokens = Math.max(1, Math.ceil(content.length / 4));
    return {
      content,
      toolCalls: [],
      provider: this.spec.providerName,
      model: this.spec.modelName,
      usage: { inputTokens: tokens, outputTokens: tokens, totalTokens: tokens * 2 }
    };
  }

  private toolResult(name: string, args: Record<string, unknown>): AiCompletionResult {
    EmployeeDomainProvider.toolSequence += 1;
    return {
      content: "",
      toolCalls: [{ id: `${this.spec.slug}-${EmployeeDomainProvider.toolSequence}`, name, arguments: args }],
      provider: this.spec.providerName,
      model: this.spec.modelName,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    };
  }
}

/** Persists the current entities + stage + memory under the employee's memory key (mirrors the travel
 *  persistence contract). */
export function employeeEntitiesToStoredState(
  entities: EmployeeEntities,
  stage: EmployeeStage,
  memory: EmployeeConversationMemory
): Record<string, unknown> {
  return {
    ...entities,
    stage,
    onboardingCompleted: entities.customerName !== null,
    greetingSent: true,
    completionStage: memory.completionStage,
    pendingContactValue: memory.pendingContactValue,
    conversationClosed: memory.conversationClosed,
    capturedReference: memory.capturedReference,
    lastAskedField: memory.lastAskedField,
    artifactOfferShown: memory.artifactOfferShown,
    declinedArtifact: memory.declinedArtifact,
    intentDiscovered: memory.intentDiscovered
  };
}

/** Safely reconstructs {@link EmployeeConversationMemory} from a stored document. */
export function employeeMemoryFromStoredState(
  value: Record<string, unknown> | null | undefined
): EmployeeConversationMemory {
  if (!value) return EMPTY_EMPLOYEE_CONVERSATION_MEMORY;
  const completionStages: readonly ConversationCompletionStage[] = [
    "NOT_OFFERED",
    "OFFERED",
    "AWAITING_CONTACT",
    "CAPTURED",
    "DECLINED"
  ];
  return {
    completionStage: completionStages.includes(value.completionStage as ConversationCompletionStage)
      ? (value.completionStage as ConversationCompletionStage)
      : "NOT_OFFERED",
    pendingContactValue: typeof value.pendingContactValue === "string" ? value.pendingContactValue : null,
    conversationClosed: value.conversationClosed === true,
    capturedReference: typeof value.capturedReference === "string" ? value.capturedReference : null,
    lastAskedField: typeof value.lastAskedField === "string" ? value.lastAskedField : null,
    artifactOfferShown: value.artifactOfferShown === true,
    declinedArtifact: value.declinedArtifact === true,
    intentDiscovered: value.intentDiscovered === true
  };
}

/** Safely reconstructs {@link EmployeeEntities} from a stored document. */
export function employeeEntitiesFromStoredState(
  value: Record<string, unknown> | null | undefined,
  domainFields: readonly EmployeeFieldSpec[]
): EmployeeEntities {
  if (!value) return EMPTY_EMPLOYEE_ENTITIES;
  const entities: EmployeeEntities = {
    customerName: typeof value.customerName === "string" ? value.customerName : null
  };
  for (const field of domainFields) {
    const raw = value[field.key];
    entities[field.key] = typeof raw === "string" || typeof raw === "number" ? raw : null;
  }
  return entities;
}

/** Reconstructs the conversational stage from a stored document (used for dashboard state reads). */
export function deriveEmployeeStage(
  value: Record<string, unknown> | null | undefined,
  hasRecommendation: boolean
): EmployeeStage {
  if (!value) return "COLLECT_NAME";
  const stage = value.stage as EmployeeStage | undefined;
  if (stage && EMPLOYEE_STAGES.includes(stage)) return stage;
  if (typeof value.customerName !== "string" || !value.customerName) return "COLLECT_NAME";
  if (hasRecommendation) return "RECOMMEND";
  return "COLLECT_DETAILS";
}

const EMPLOYEE_STAGES: readonly EmployeeStage[] = [
  "COLLECT_NAME",
  "DISCOVER_INTENT",
  "COLLECT_DETAILS",
  "RECOMMEND",
  "AWAITING_CONTACT",
  "CAPTURED",
  "ESCALATED"
];

/** The system prompt used by the {@link EmployeeDomainLlmOrchestrator} for semantic entity extraction —
 *  asks the real provider to return a strict JSON object matching the domain's field keys plus intent. */
export function buildEmployeeExtractionSystemPrompt(spec: EmployeeDomainSpec): string {
  const fieldKeys = spec.fields.map((field) => field.key);
  const keys = ["customerName", ...fieldKeys];
  return [
    `You are a semantic interpretation engine for the ${spec.slug} AI Employee.`,
    "Extract structured fields from the user's message.",
    `Return ONLY a strict JSON object with these keys (use null when unknown): ${keys.join(", ")}.`,
    "Also include an \"intent\" field: a short phrase describing what the user wants help with, or null.",
    "Never invent values. When a field is not mentioned, set it to null.",
    "Rules:",
    "- customerName: the user's name only when they explicitly state it.",
    ...(spec.intentHint ? [`- Domain context: ${spec.intentHint}`] : []),
    "- Keep values short and factual."
  ].join("\n");
}

/**
 * LLM + tool-calling conversation engine shared by every domain employee. Wraps a real {@link AiProvider}:
 * each turn it sends the conversation plus a domain extraction system prompt so the underlying model can
 * propose semantic JSON (fields + intent), then it validates/merges those values into the same
 * {@link EmployeeDomainProvider} deterministic engine, so dashboard chat and channel conversations behave
 * identically regardless of which engine handled earlier turns. Exposes `lastMemory`, `lastEntities`, and
 * `lastStage` for AgentService persistence.
 */
export class EmployeeDomainLlmOrchestrator implements AiProvider {
  lastEntities: EmployeeEntities;
  lastStage: EmployeeStage = "COLLECT_NAME";
  private readonly inner: EmployeeDomainProvider;
  private readonly spec: EmployeeDomainSpec;
  private readonly config: EmployeeRuntimeConfig;
  private readonly realProvider: AiProvider;

  constructor(
    realProvider: AiProvider,
    spec: EmployeeDomainSpec,
    config: EmployeeRuntimeConfig,
    priorEntities: EmployeeEntities,
    priorMemory: EmployeeConversationMemory = EMPTY_EMPLOYEE_CONVERSATION_MEMORY
  ) {
    this.realProvider = realProvider;
    this.spec = spec;
    this.config = config;
    this.lastEntities = priorEntities;
    this.inner = new EmployeeDomainProvider(spec, config, priorMemory, priorEntities);
  }

  get lastMemory(): EmployeeConversationMemory {
    return this.inner.lastMemory;
  }

  get lastRoutingHandoffSignal(): RoutingHandoffSignal | null {
    return this.inner.lastRoutingHandoffSignal;
  }

  /** Merges any newly extracted entity values into the persisted entity bag. */
  mergeExtracted(extracted: EmployeeEntities): void {
    if (typeof extracted.customerName === "string" && extracted.customerName.trim())
      this.lastEntities = { ...this.lastEntities, customerName: extracted.customerName.trim() };
    for (const field of this.spec.fields) {
      const value = extracted[field.key];
      if (typeof value === "string" && value.trim())
        this.lastEntities = { ...this.lastEntities, [field.key]: value.trim() };
      else if (typeof value === "number")
        this.lastEntities = { ...this.lastEntities, [field.key]: value };
    }
  }

  /** Instruction injected into LLM prompts so legal/general queries default to the configured country's
   *  jurisdiction (India by default) unless the user explicitly names another country. */
  private countryBiasInstruction(): string {
    const country = this.config.defaultCountry?.trim() || "India";
    return `Unless the user explicitly names a different country, answer with ${country}'s laws, courts, and legal framework in mind. When they ask about a verdict/case without specifying a country, default to ${country}.`;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    // First run the deterministic engine so the state machine (name gate, missing fields, offer/consent,
    // escalation, attachment read, out-of-scope routing) is always authoritative for routing. The real
    // provider only adds richer wording for ordinary conversational turns.
    const deterministic = await this.inner.complete(request);
    this.lastEntities = this.inner.lastEntities;
    this.lastStage = this.lastStageFor(this.lastEntities);

    // When the deterministic engine produced a pending tool call (escalate / create_artifact), honor it
    // directly — tool names and payloads must be exactly what the tool catalog registers.
    if (deterministic.toolCalls.length > 0) return deterministic;

    // Never send the deterministic engine's structured/decision replies through the LLM for "enrichment":
    // an attachment-read summary, an out-of-scope routing reply, or a direct info answer is the intended
    // final response. Rewriting them via the real provider would lose the routing intent (and could turn a
    // "this document belongs to the Finance Employee" reply into a generic travel suggestion).
    if (this.inner.lastWasStructuredReply) return deterministic;

    const extractionPrompt = buildEmployeeExtractionSystemPrompt(this.spec);
    const extraction = await this.realProvider.complete({
      messages: [
        { role: "system", content: extractionPrompt },
        ...request.messages.map((message) =>
          message.role === "system" ? { ...message, role: "user" as const, content: message.content } : message
        )
      ],
      temperature: 0,
      maxOutputTokens: 500
    });
    const extracted = this.parseExtraction(extraction.content);
    if (extracted) {
      this.mergeExtracted(extracted);
      this.inner.syncEntities(this.lastEntities);
    }
    this.lastEntities = this.inner.lastEntities;
    this.lastStage = this.lastStageFor(this.lastEntities);

    // Re-run the deterministic engine with the (possibly enriched) entity bag so the reply reflects the
    // newly extracted values, then enrich the final wording with the real provider for a natural reply.
    const final = await this.inner.complete(request);
    this.lastEntities = this.inner.lastEntities;
    this.lastStage = this.lastStageFor(this.lastEntities);
    if (final.toolCalls.length > 0) return final;

    return this.enrichReply(final, request);
  }

  private async enrichReply(
    result: AiCompletionResult,
    request: AiCompletionRequest
  ): Promise<AiCompletionResult> {
    try {
      const enriched = await this.realProvider.complete({
        messages: [
          {
            role: "system",
            content: `You are the ${this.spec.slug} AI Employee. ${this.config.persona}\n
${this.countryBiasInstruction()}
Format the reply clearly and professionally: use short sections with bold headings, bullet points for lists, and blank lines between sections. Never dump raw text — keep it readable and well-aligned.
Rewrite the following reply so it sounds natural and helpful, staying truthful and concise. Do not invent facts, bookings, or outcomes. Return only the rewritten reply.`
          },
          ...request.messages.map((message) =>
            message.role === "system" ? { ...message, role: "user" as const, content: message.content } : message
          ),
          { role: "assistant", content: result.content }
        ],
        temperature: 0.4,
        maxOutputTokens: 500
      });
      const content = enriched.content?.trim();
      if (content) return { ...result, content };
    } catch {
      // Fall back to the deterministic reply when the real provider is unavailable this turn.
    }
    return result;
  }

  private parseExtraction(content: string): EmployeeEntities | null {
    if (!content) return null;
    try {
      const json = JSON.parse(content) as Record<string, unknown>;
      const entities: EmployeeEntities = { customerName: null };
      for (const field of this.spec.fields) {
        const raw = json[field.key];
        entities[field.key] = typeof raw === "string" || typeof raw === "number" ? raw : null;
      }
      if (typeof json.customerName === "string") entities.customerName = json.customerName;
      return entities;
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        const json = JSON.parse(match[0]) as Record<string, unknown>;
        const entities: EmployeeEntities = { customerName: null };
        for (const field of this.spec.fields) {
          const raw = json[field.key];
          entities[field.key] = typeof raw === "string" || typeof raw === "number" ? raw : null;
        }
        if (typeof json.customerName === "string") entities.customerName = json.customerName;
        return entities;
      } catch {
        return null;
      }
    }
  }

  private lastStageFor(entities: EmployeeEntities): EmployeeStage {
    if (this.inner.lastMemory.completionStage === "CAPTURED") return "CAPTURED";
    if (this.inner.lastMemory.completionStage === "AWAITING_CONTACT") return "AWAITING_CONTACT";
    if (!entities.customerName) return "COLLECT_NAME";
    if (!this.inner.lastMemory.intentDiscovered) return "DISCOVER_INTENT";
    const missing = this.spec.fields.filter(
      (field) => !field.optional && (typeof entities[field.key] !== "string" || !entities[field.key])
    );
    if (missing.length === 0) return "RECOMMEND";
    return "COLLECT_DETAILS";
  }
}
