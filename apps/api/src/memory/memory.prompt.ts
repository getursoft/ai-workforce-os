import type { MemoryContext, MemoryRecordValue } from "./memory.types";

/**
 * Sprint 4.5: builds the memory block injected into every AI Employee prompt.
 *
 * The block is assembled in the required retrieval order — Organization -> Employee -> User ->
 * Conversation Summary — and handed to the shared PromptBuilder, which places it before retrieved
 * knowledge (so memory is never buried behind RAG) and before conversation history.
 */

const MAX_LINES = 40;
const MAX_LINE_LENGTH = 400;

function importanceLabel(record: MemoryRecordValue): string {
  if (record.importance === "CRITICAL") return "CRITICAL";
  if (record.importance === "HIGH") return "HIGH";
  return "";
}

function formatValue(record: MemoryRecordValue): string {
  const raw = record.value;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean")
    return String(raw);
  if (typeof raw === "object" && raw !== null && "value" in raw)
    return String((raw as { value: unknown }).value);
  return JSON.stringify(raw).slice(0, MAX_LINE_LENGTH);
}

function formatRecord(record: MemoryRecordValue): string {
  const label = importanceLabel(record);
  const line = `${record.key}: ${formatValue(record)}${label ? ` (${label})` : ""}`;
  return line.slice(0, MAX_LINE_LENGTH);
}

function section(title: string, records: MemoryRecordValue[], omitTitle: boolean): string[] {
  if (!records.length) return [];
  const lines = records.map(formatRecord).slice(0, MAX_LINES);
  return omitTitle ? lines : [`${title}`, ...lines.map((line) => `- ${line}`)];
}

/**
 * Formats a {@link MemoryContext} as an array of prompt lines (or an empty array when nothing was
 * retrieved). The AgentService passes these to PromptBuilder's `memories` slot.
 */
export function buildMemoryContextBlock(
  context: MemoryContext,
  includeEmptySummary = false
): string[] {
  const lines: string[] = [];
  lines.push(
    ...section("Organization memory", context.organization, false),
    ...section("Employee memory", context.employee, false),
    ...section("User memory", context.user, false)
  );
  if (context.conversationSummary) {
    lines.push(
      "Conversation summary",
      `- ${context.conversationSummary.slice(0, MAX_LINE_LENGTH * 4)}`
    );
  } else if (includeEmptySummary && context.conversationSummaryVersion !== null) {
    lines.push("Conversation summary", "- (no summary yet)");
  }
  return lines;
}

/** Joins a memory context block into the single string PromptBuilder expects per memory item. */
export function formatMemoryContextBlock(context: MemoryContext): string {
  return buildMemoryContextBlock(context).join("\n");
}
