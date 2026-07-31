import type { MemoryImportance, MemoryScope, MemorySource } from "@prisma/client";

/**
 * Sprint 4.5 platform memory — shared types for the MemoryService.
 *
 * Memory is a first-class platform capability separate from Knowledge (RAG), conversation history,
 * and the legacy AgentMemory conversation-state blobs. Every AI Employee benefits automatically
 * because the shared AgentService run loop reads these records and injects them into every prompt.
 */

/** The user-facing shape of a persisted memory record (confidence Decimal flattened to number). */
export interface MemoryRecordValue {
  id: string;
  organizationId: string;
  employeeId: string | null;
  userId: string | null;
  conversationId: string | null;
  scope: MemoryScope;
  category: string;
  key: string;
  value: Record<string, unknown>;
  searchableText: string | null;
  confidence: number;
  importance: MemoryImportance;
  source: MemorySource;
  metadata: Record<string, unknown>;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** A memory record with its retrieval score attached (see memory/ranking.ts). */
export interface MemorySearchHit extends MemoryRecordValue {
  score: number;
  semanticScore: number;
  keywordScore: number;
}

/**
 * The per-turn memory context injected into every employee prompt, in the required retrieval order:
 * Organization -> Employee -> User -> Conversation Summary (then recent messages, knowledge, current
 * message are appended by the shared PromptBuilder).
 */
export interface MemoryContext {
  organization: MemoryRecordValue[];
  employee: MemoryRecordValue[];
  user: MemoryRecordValue[];
  conversationSummary: string | null;
  conversationSummaryVersion: number | null;
}

/** A memory produced by the deterministic extraction rules (memory.extractor.ts). */
export interface ExtractedMemory {
  key: string;
  category: string;
  value: Record<string, unknown> | string | number | boolean;
  importance: MemoryImportance;
  confidence: number;
  source: MemorySource;
  /** Scope is almost always USER; a rule may override (e.g. an ephemeral CONVERSATION fact). */
  scope: MemoryScope;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

/** Configuration for a single deterministic extraction rule. */
export interface MemoryExtractionRule {
  id: string;
  category: string;
  key: string;
  importance: MemoryImportance;
  confidence: number;
  /** When true the memory is only stored (not surfaced as a one-off extraction). */
  source: MemorySource;
  pattern: RegExp;
  /** True for the generic "remember I prefer X" catch-all: it only fires when no specific rule matched. */
  fallback?: boolean;
  /** Builds the extracted memory from the full text + regex match; null when not confident. */
  extract: (text: string, match: RegExpMatchArray) => ExtractedMemory | null;
}

/** Scope filter used by list/search/forget. */
export interface MemoryScopeFilter {
  organizationId: string;
  employeeId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  scope?: MemoryScope | null;
  category?: string | null;
  key?: string | null;
  importance?: MemoryImportance | null;
  source?: MemorySource | null;
  includeExpired?: boolean;
  includeDeleted?: boolean;
}

/** Weights used by the memory ranking algorithm (memory/ranking.ts). */
export const MEMORY_RANKING_WEIGHTS = {
  semantic: 0.45,
  keyword: 0.35,
  recency: 0.1,
  importance: 0.1,
  /** Days after which a memory's recency boost decays by ~63%. */
  recencyHalfLifeDays: 30
} as const;

export const MEMORY_IMPORTANCE_WEIGHT: Record<MemoryImportance, number> = {
  LOW: 0,
  MEDIUM: 0.25,
  HIGH: 0.6,
  CRITICAL: 1
};
