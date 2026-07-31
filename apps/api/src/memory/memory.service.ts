import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { MemoryAuditAction, MemoryImportance, MemoryScope, MemorySource, Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { KnowledgeEmbeddingService } from "../knowledge/knowledge.embedding";
import { extractMemories } from "./memory.extractor";
import { buildMemoryContextBlock } from "./memory.prompt";
import { rankMemories } from "./memory.ranking";
import type {
  MemoryContext,
  MemoryRecordValue,
  MemoryScopeFilter,
  MemorySearchHit
} from "./memory.types";

/**
 * Sprint 4.5: the platform MemoryService.
 *
 * This is the ONLY way memory records are read/written — no AI Employee touches Prisma for memory.
 * Every employee benefits automatically because the shared AgentService run loop calls `recall` for
 * each turn's prompt and `extractAndRemember` for each user message.
 *
 * Guarantees:
 * - Tenant isolation: every query filters by organizationId before anything else; no memory can leak
 *   across organizations.
 * - RBAC: enforced at the controller layer (`agents.memory.read` / `agents.memory.write`).
 * - Audited: every create/update/forget/expire/recall/search writes a MemoryAuditEvent.
 * - Durable but bounded: `summarizeConversation` collapses long conversations so prompts never explode.
 */

export interface MemoryActor {
  /** Dashboard user id, or null for channel/customer actors. */
  userId: string | null;
  /** The AI Employee (Plugin installation) handling the turn. */
  employeeId: string | null;
  /** The conversation being processed (null for dashboard-wide reads). */
  conversationId?: string | null;
}

export interface RememberMemoryInput {
  organizationId: string;
  scope: "USER" | "EMPLOYEE" | "ORGANIZATION" | "CONVERSATION" | "GLOBAL";
  key: string;
  category: string;
  value: Record<string, unknown>;
  employeeId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  confidence?: number | undefined;
  importance?: MemoryImportance | undefined;
  source?: MemorySource | undefined;
  searchableText?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  expiresAt?: Date | null | undefined;
  actorId?: string | null;
}

/** The max number of raw messages a prompt uses once a conversation summary exists. */
export const MEMORY_PROMPT_RECENT_MESSAGES = 20;
export const MEMORY_SUMMARIZE_THRESHOLD = 20;
export const MEMORY_SEARCH_CANDIDATE_LIMIT = 200;
export const MEMORY_CONTEXT_LIMIT = 60;

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: KnowledgeEmbeddingService,
    private readonly auditLogger: AuditEventLogger
  ) {}

  /* ----------------------------------------------------------------------------
   * Write path
   * ------------------------------------------------------------------------- */

  /** Creates a memory record, or updates the existing live record for the same (scope, key, owner). */
  async remember(input: RememberMemoryInput): Promise<MemoryRecordValue> {
    if (!input.key?.trim()) throw new BadRequestException("MEMORY_KEY_REQUIRED");
    await this.assertScopedReferences(input);
    const owner = ownerWhere(input);
    const existing = await this.prisma.memoryRecord.findFirst({
      where: { organizationId: input.organizationId, deletedAt: null, ...owner }
    });
    const searchableText =
      input.searchableText ??
      (typeof input.value === "string" ? input.value : JSON.stringify(input.value)).slice(0, 2000);
    const data = {
      value: input.value as Prisma.InputJsonValue,
      searchableText,
      confidence: input.confidence ?? 1,
      importance: (input.importance ?? "MEDIUM") as MemoryImportance,
      source: (input.source ?? "DASHBOARD") as MemorySource,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      expiresAt: input.expiresAt ?? null,
      deletedAt: null
    };
    const row = existing
      ? await this.prisma.memoryRecord.update({
          where: { id: existing.id },
          data: { ...data, category: input.category || existing.category }
        })
      : await this.prisma.memoryRecord.create({
          data: {
            organizationId: input.organizationId,
            employeeId: input.employeeId ?? null,
            userId: input.userId ?? null,
            conversationId: input.conversationId ?? null,
            scope: input.scope as MemoryScope,
            category: input.category || "GENERAL",
            key: input.key,
            ...data
          }
        });
    await this.attachEmbedding(
      input.organizationId,
      input.employeeId ?? "",
      row.id,
      searchableText
    );
    await this.audit({
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      memoryId: row.id,
      action: existing ? MemoryAuditAction.UPDATE : MemoryAuditAction.CREATE,
      scope: row.scope,
      key: row.key,
      category: row.category
    });
    return this.toMemoryRecordValue(row);
  }

  /** Updates an existing live memory record by id (org-scoped). */
  async update(
    organizationId: string,
    id: string,
    dto: {
      value?: Record<string, unknown> | undefined;
      searchableText?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      confidence?: number | undefined;
      importance?: MemoryImportance | undefined;
      category?: string | undefined;
      key?: string | undefined;
      expiresAt?: Date | null;
    },
    actorId?: string | null
  ): Promise<MemoryRecordValue> {
    const existing = await this.prisma.memoryRecord.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!existing) throw new NotFoundException("MEMORY_NOT_FOUND");
    const searchableText = dto.searchableText ?? existing.searchableText ?? "";
    const row = await this.prisma.memoryRecord.update({
      where: { id },
      data: {
        ...(dto.value !== undefined ? { value: dto.value as Prisma.InputJsonValue } : {}),
        ...(dto.searchableText !== undefined ? { searchableText: dto.searchableText } : {}),
        ...(dto.metadata !== undefined ? { metadata: dto.metadata as Prisma.InputJsonValue } : {}),
        ...(dto.confidence !== undefined ? { confidence: dto.confidence } : {}),
        ...(dto.importance !== undefined ? { importance: dto.importance as MemoryImportance } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.key !== undefined ? { key: dto.key } : {}),
        ...(dto.expiresAt !== undefined ? { expiresAt: dto.expiresAt } : {})
      }
    });
    await this.attachEmbedding(organizationId, existing.employeeId ?? "", row.id, searchableText);
    await this.audit({
      organizationId,
      actorId: actorId ?? null,
      memoryId: row.id,
      action: MemoryAuditAction.UPDATE,
      scope: row.scope,
      key: row.key,
      category: row.category
    });
    return this.toMemoryRecordValue(row);
  }

  /** Soft-deletes a memory record (org-scoped). */
  async forget(
    organizationId: string,
    id: string,
    actorId?: string | null
  ): Promise<MemoryRecordValue> {
    const existing = await this.prisma.memoryRecord.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!existing) throw new NotFoundException("MEMORY_NOT_FOUND");
    const row = await this.prisma.memoryRecord.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
    await this.audit({
      organizationId,
      actorId: actorId ?? null,
      memoryId: row.id,
      action: MemoryAuditAction.DELETE,
      scope: row.scope,
      key: row.key,
      category: row.category
    });
    return this.toMemoryRecordValue(row);
  }

  /** Bulk forget ("Forget my airline preference", "Delete only travel memories"). */
  async forgetByCriteria(
    organizationId: string,
    criteria: MemoryScopeFilter,
    actorId?: string | null
  ): Promise<{ count: number; ids: string[] }> {
    const where = this.filterWhere(organizationId, criteria);
    const rows = await this.prisma.memoryRecord.findMany({
      where,
      select: { id: true, scope: true, key: true, category: true }
    });
    if (!rows.length) return { count: 0, ids: [] };
    const result = await this.prisma.memoryRecord.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, organizationId, deletedAt: null },
      data: { deletedAt: new Date() }
    });
    for (const row of rows)
      await this.audit({
        organizationId,
        actorId: actorId ?? null,
        memoryId: row.id,
        action: MemoryAuditAction.DELETE,
        scope: row.scope,
        key: row.key,
        category: row.category,
        changeSummary: "bulk forget"
      });
    return { count: result.count, ids: rows.map((row) => row.id) };
  }

  /* ----------------------------------------------------------------------------
   * Read path
   * ------------------------------------------------------------------------- */

  /** Lists memory records for the dashboard (admin-oriented, org-scoped, filterable). */
  async list(
    organizationId: string,
    actorId: string,
    filters: MemoryScopeFilter,
    page: { page: number; pageSize: number }
  ): Promise<{ items: MemoryRecordValue[]; total: number }> {
    const extras: { userScope?: Prisma.MemoryRecordWhereInput } = {};
    if (!filters.userId)
      // The User Memory tab shows the actor's own memories + userless (channel customer) records, so a
      // non-admin user never sees other users' personal memories. Admins can filter by a specific userId.
      extras.userScope = { OR: [{ userId: actorId }, { userId: null }] };
    const where = this.filterWhere(organizationId, filters, extras);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.memoryRecord.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize
      }),
      this.prisma.memoryRecord.count({ where })
    ]);
    return { items: items.map((row) => this.toMemoryRecordValue(row)), total };
  }

  /**
   * Per-actor scoped recall for prompt injection. Returns the memory context in the required order:
   * Organization -> Employee -> User -> Conversation Summary.
   */
  async recall(organizationId: string, actor: MemoryActor): Promise<MemoryContext> {
    const now = new Date();
    const records = await this.prisma.memoryRecord.findMany({
      where: {
        organizationId,
        deletedAt: null,
        AND: [
          { OR: this.visibilityOr(actor) },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: MEMORY_CONTEXT_LIMIT
    });
    const values = records.map((row) => this.toMemoryRecordValue(row));
    const summary = actor.conversationId
      ? await this.prisma.conversationSummary.findUnique({
          where: { conversationId: actor.conversationId }
        })
      : null;
    const context: MemoryContext = {
      organization: values.filter((record) => record.scope === "ORGANIZATION"),
      employee: values.filter(
        (record) => record.scope === "EMPLOYEE" && record.employeeId === actor.employeeId
      ),
      user: values.filter(
        (record) =>
          record.scope === "USER" &&
          (record.userId === actor.userId || record.userId === null)
      ),
      conversationSummary: summary?.summary ?? null,
      conversationSummaryVersion: summary?.summaryVersion ?? null
    };
    if (actor.conversationId)
      await this.audit({
        organizationId,
        actorId: actor.userId,
        memoryId: "00000000-0000-0000-0000-000000000000",
        action: MemoryAuditAction.RECALL,
        scope: "CONVERSATION",
        key: "recall",
        category: "RECALL",
        metadata: { count: records.length }
      });
    return context;
  }

  /** Formats a recall context as prompt lines (convenience for AgentService + tests). */
  formatContext(context: MemoryContext): string[] {
    return buildMemoryContextBlock(context);
  }

  /** Hybrid search: tenant+actor scoped, exact/keyword + optional semantic, ranked. */
  async search(
    organizationId: string,
    actor: MemoryActor,
    input: {
      query: string;
      employeeId?: string | null;
      conversationId?: string | null;
      limit?: number | undefined;
      minScore?: number | undefined;
      semantic?: boolean | undefined;
      scope?: MemoryScope | undefined;
    }
  ): Promise<MemorySearchHit[]> {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const query = input.query.trim();
    const now = new Date();
    const keywordWhere: Prisma.MemoryRecordWhereInput[] = query
      ? [
          {
            OR: [
              { key: { contains: query, mode: "insensitive" } },
              { category: { contains: query, mode: "insensitive" } },
              { searchableText: { contains: query, mode: "insensitive" } }
            ]
          }
        ]
      : [];
    const records = await this.prisma.memoryRecord.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(input.scope ? { scope: input.scope as MemoryScope } : {}),
        AND: [
          { OR: this.visibilityOr({ ...actor, employeeId: input.employeeId ?? actor.employeeId }) },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ...keywordWhere
        ]
      },
      orderBy: { updatedAt: "desc" },
      take: MEMORY_SEARCH_CANDIDATE_LIMIT
    });
    const values = records.map((row) => this.toMemoryRecordValue(row));
    let semanticScores = new Map<string, number>();
    const embeddableEmployeeId = input.employeeId ?? actor.employeeId;
    if (input.semantic !== false && query && embeddableEmployeeId && values.length)
      semanticScores = await this.semanticScoresFor(
        organizationId,
        embeddableEmployeeId,
        query,
        values.map((record) => record.id)
      );
    const ranked = rankMemories(query, values, semanticScores)
      .filter((hit) => hit.score >= (input.minScore ?? 0))
      .slice(0, limit);
    await this.audit({
      organizationId,
      actorId: actor.userId,
      memoryId: "00000000-0000-0000-0000-000000000000",
      action: MemoryAuditAction.SEARCH,
      scope: "GLOBAL",
      key: "search",
      category: "SEARCH",
      metadata: { query, hits: ranked.length }
    });
    return ranked;
  }

  /** Exposes the ranking algorithm for callers that already have records in hand. */
  rank(query: string, records: MemoryRecordValue[]): MemorySearchHit[] {
    return rankMemories(query, records);
  }

  /** Lists the durable audit trail for an organization (memoryId/scope filtered). */
  async listAuditEvents(
    organizationId: string,
    filters: { memoryId?: string | undefined; scope?: MemoryScope | undefined; page: number; pageSize: number }
  ): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
    const where = {
      organizationId,
      ...(filters.memoryId ? { memoryId: filters.memoryId } : {}),
      ...(filters.scope ? { scope: filters.scope as MemoryScope } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.memoryAuditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize
      }),
      this.prisma.memoryAuditEvent.count({ where })
    ]);
    return {
      items: items.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        actorId: row.actorId,
        memoryId: row.memoryId,
        action: row.action,
        scope: row.scope,
        key: row.key,
        category: row.category,
        changeSummary: row.changeSummary,
        createdAt: row.createdAt
      })),
      total
    };
  }

  /* ----------------------------------------------------------------------------
   * Conversation summarization
   * ------------------------------------------------------------------------- */

  /** Summarizes a conversation and stores the rolling summary + a CONVERSATION-scope memory record. */
  async summarizeConversation(
    organizationId: string,
    conversationId: string,
    actorId?: string | null
  ): Promise<{ summary: string; version: number; summarizedMessageCount: number }> {
    await this.assertConversation(organizationId, conversationId);
    const messages = await this.prisma.conversationMessage.findMany({
      where: { conversationId, organizationId },
      orderBy: { createdAt: "asc" }
    });
    const existing = await this.prisma.conversationSummary.findUnique({
      where: { conversationId }
    });
    const since = existing?.summarizedMessageCount ?? 0;
    const newMessages = messages.slice(since);
    const summary = buildDeterministicSummary(existing?.summary ?? null, newMessages, 4000);
    const upserted = await this.prisma.conversationSummary.upsert({
      where: { conversationId },
      create: {
        organizationId,
        conversationId,
        summary,
        summarizedMessageCount: messages.length,
        summaryVersion: 1
      },
      update: {
        summary,
        summarizedMessageCount: messages.length,
        summaryVersion: { increment: 1 }
      }
    });
    await this.remember({
      organizationId,
      scope: "CONVERSATION",
      key: "conversation.summary",
      category: "SUMMARY",
      value: { summary },
      employeeId: null,
      userId: null,
      conversationId,
      confidence: 1,
      importance: "MEDIUM",
      source: "SYSTEM",
      searchableText: summary.slice(0, 2000),
      actorId: actorId ?? null
    });
    await this.audit({
      organizationId,
      actorId: actorId ?? null,
      memoryId: "00000000-0000-0000-0000-000000000000",
      action: MemoryAuditAction.SUMMARIZE,
      scope: "CONVERSATION",
      key: "conversation.summary",
      category: "SUMMARY",
      changeSummary: `summarized ${newMessages.length} new message(s)`
    });
    return {
      summary,
      version: upserted.summaryVersion,
      summarizedMessageCount: messages.length
    };
  }

  /** Summarizes only when enough new messages have accumulated since the last summary. */
  async maybeSummarizeConversation(
    organizationId: string,
    conversationId: string,
    threshold = MEMORY_SUMMARIZE_THRESHOLD
  ): Promise<boolean> {
    try {
      const [count, existing] = await Promise.all([
        this.prisma.conversationMessage.count({ where: { conversationId, organizationId } }),
        this.prisma.conversationSummary.findUnique({ where: { conversationId } })
      ]);
      const since = existing?.summarizedMessageCount ?? 0;
      if (count - since >= threshold && count >= threshold) {
        await this.summarizeConversation(organizationId, conversationId, null);
        return true;
      }
      return false;
    } catch (error) {
      this.logger.warn({
        event: "CONVERSATION_SUMMARIZATION_SKIPPED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return false;
    }
  }

  /* ----------------------------------------------------------------------------
   * Merge / expiry
   * ------------------------------------------------------------------------- */

  /** Merges duplicate records sharing a (scope, key) — keeps the newest, soft-deletes the rest. */
  async merge(
    organizationId: string,
    ids: string[],
    actorId?: string | null
  ): Promise<{ survivor: MemoryRecordValue; merged: number }> {
    const unique = [...new Set(ids)];
    const records = await this.prisma.memoryRecord.findMany({
      where: { id: { in: unique }, organizationId, deletedAt: null }
    });
    if (!records.length) throw new NotFoundException("MEMORY_NOT_FOUND");
    const groups = new Map<string, typeof records>();
    for (const record of records) {
      const signature = `${record.scope}:${record.employeeId ?? ""}:${record.userId ?? ""}:${record.key}`;
      const group = groups.get(signature) ?? [];
      group.push(record);
      groups.set(signature, group);
    }
    let merged = 0;
    const initial = records[0];
    let survivorId = initial?.id ?? null;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      );
      const survivor = sorted[0];
      if (!survivor) continue;
      survivorId = survivor.id;
      for (const duplicate of sorted.slice(1)) {
        await this.prisma.memoryRecord.update({
          where: { id: duplicate.id },
          data: { deletedAt: new Date() }
        });
        await this.audit({
          organizationId,
          actorId: actorId ?? null,
          memoryId: duplicate.id,
          action: MemoryAuditAction.MERGE,
          scope: duplicate.scope,
          key: duplicate.key,
          category: duplicate.category,
          changeSummary: `merged into ${survivor.id}`
        });
        merged += 1;
      }
    }
    if (!survivorId) throw new NotFoundException("MEMORY_NOT_FOUND");
    const survivor = await this.prisma.memoryRecord.findUniqueOrThrow({ where: { id: survivorId } });
    return { survivor: this.toMemoryRecordValue(survivor), merged };
  }

  /** Marks every expired live record as deleted (memory decay). Returns the number expired. */
  async expire(organizationId: string, scope?: MemoryScope): Promise<number> {
    const result = await this.prisma.memoryRecord.updateMany({
      where: {
        organizationId,
        deletedAt: null,
        expiresAt: { not: null, lte: new Date() },
        ...(scope ? { scope: scope as MemoryScope } : {})
      },
      data: { deletedAt: new Date() }
    });
    return result.count;
  }

  /* ----------------------------------------------------------------------------
   * Extraction hook (platform-wide; every employee benefits automatically)
   * ------------------------------------------------------------------------- */

  /**
   * Runs the deterministic extraction rules against a user message and persists every confident fact.
   * Called by the shared AgentService run loop after each turn — no AI Employee carries this code.
   */
  async extractAndRemember(input: {
    organizationId: string;
    actorId?: string | null;
    employeeId: string;
    conversationId: string;
    userId: string | null;
    text: string;
  }): Promise<{ extracted: number; remembered: MemoryRecordValue[] }> {
    const extracted = extractMemories(input.text);
    if (!extracted.length) return { extracted: 0, remembered: [] };
    const remembered: MemoryRecordValue[] = [];
    for (const mem of extracted) {
      const scope = mem.scope;
      const record = await this.remember({
        organizationId: input.organizationId,
        scope,
        key: mem.key,
        category: mem.category,
        value: typeof mem.value === "object" && mem.value !== null ? mem.value : { value: mem.value },
        employeeId: input.employeeId,
        userId: scope === "USER" ? input.userId : null,
        conversationId: input.conversationId,
        confidence: mem.confidence,
        importance: mem.importance,
        source: mem.source,
        metadata: mem.metadata,
        expiresAt: mem.expiresAt,
        searchableText: typeof mem.value === "string" ? mem.value : JSON.stringify(mem.value),
        actorId: input.actorId ?? null
      });
      remembered.push(record);
    }
    return { extracted: extracted.length, remembered };
  }

  /* ----------------------------------------------------------------------------
   * Private helpers
   * ------------------------------------------------------------------------- */

  private visibilityOr(actor: MemoryActor): Prisma.MemoryRecordWhereInput[] {
    const conditions: Prisma.MemoryRecordWhereInput[] = [{ scope: "ORGANIZATION" }];
    if (actor.employeeId) conditions.push({ scope: "EMPLOYEE", employeeId: actor.employeeId });
    if (actor.conversationId) {
      conditions.push({ scope: "CONVERSATION", conversationId: actor.conversationId });
      // Channel/customer (userless) user memories stay scoped to their own conversation.
      conditions.push({ scope: "USER", userId: null, employeeId: actor.employeeId, conversationId: actor.conversationId });
    }
    if (actor.userId) conditions.push({ scope: "USER", userId: actor.userId });
    return conditions;
  }

  private filterWhere(
    organizationId: string,
    filters: MemoryScopeFilter,
    extras?: { userScope?: Prisma.MemoryRecordWhereInput }
  ): Prisma.MemoryRecordWhereInput {
    const where: Prisma.MemoryRecordWhereInput = {
      organizationId,
      ...(filters.includeDeleted ? {} : { deletedAt: null }),
      ...(filters.scope ? { scope: filters.scope as MemoryScope } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.key ? { key: { contains: filters.key, mode: "insensitive" } } : {}),
      ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(filters.importance ? { importance: filters.importance as MemoryImportance } : {}),
      ...(filters.source ? { source: filters.source as MemorySource } : {})
    };
    if (filters.userId) where.userId = filters.userId;
    if (extras?.userScope) where.AND = extras.userScope;
    return where;
  }

  private async assertScopedReferences(input: RememberMemoryInput): Promise<void> {
    if (input.conversationId) await this.assertConversation(input.organizationId, input.conversationId);
    if (input.employeeId)
      if (
        !(await this.prisma.plugin.count({
          where: { id: input.employeeId, organizationId: input.organizationId, deletedAt: null }
        }))
      )
        throw new BadRequestException("EMPLOYEE_NOT_FOUND");
    if (input.userId)
      if (
        !(await this.prisma.user.count({
          where: { id: input.userId, organizationId: input.organizationId }
        }))
      )
        throw new BadRequestException("USER_NOT_FOUND");
  }

  private async assertConversation(organizationId: string, conversationId: string): Promise<void> {
    const count = await this.prisma.conversation.count({
      where: { id: conversationId, organizationId, deletedAt: null }
    });
    if (!count) throw new NotFoundException("CONVERSATION_NOT_FOUND");
  }

  private async attachEmbedding(
    organizationId: string,
    employeeId: string,
    memoryId: string,
    text: string
  ): Promise<void> {
    try {
      const result = await this.embeddings.embed(organizationId, employeeId || "", [text]);
      const vector = result.vectors[0];
      if (!vector) return;
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE memory_records
        SET embedding = ${`[${vector.join(",")}]`}::vector,
            embedding_model = ${result.model},
            embedding_dimensions = ${result.dimensions}
        WHERE id = ${memoryId}::uuid
      `);
    } catch {
      // Embedding failure must never fail a memory save — exact/keyword retrieval still works.
    }
  }

  private async semanticScoresFor(
    organizationId: string,
    employeeId: string,
    query: string,
    ids: string[]
  ): Promise<Map<string, number>> {
    try {
      const vector = (await this.embeddings.embed(organizationId, employeeId, [query])).vectors[0];
      if (!vector) return new Map();
      const rows = await this.prisma.$queryRaw<Array<{ id: string; semantic: number }>>(Prisma.sql`
        SELECT id, 1 - (embedding <=> ${`[${vector.join(",")}]`}::vector) AS semantic
        FROM memory_records
        WHERE organization_id = ${organizationId}::uuid
          AND id = ANY(${ids}::uuid[])
          AND embedding IS NOT NULL
      `);
      return new Map(rows.map((row) => [row.id, Number(row.semantic)]));
    } catch {
      return new Map();
    }
  }

  private async audit(input: {
    organizationId: string;
    actorId: string | null;
    memoryId: string;
    action: MemoryAuditAction;
    scope: "USER" | "EMPLOYEE" | "ORGANIZATION" | "CONVERSATION" | "GLOBAL";
    key: string;
    category: string;
    changeSummary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    try {
      if (input.memoryId !== fakeId)
        await this.prisma.memoryAuditEvent.create({
          data: {
            organizationId: input.organizationId,
            actorId: input.actorId,
            memoryId: input.memoryId,
            action: input.action,
            scope: input.scope as MemoryScope,
            key: input.key.slice(0, 160),
            category: input.category.slice(0, 80),
            changeSummary: input.changeSummary ?? null,
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
          }
        });
    } catch (error) {
      this.logger.warn({
        event: "MEMORY_AUDIT_WRITE_FAILED",
        error: error instanceof Error ? error.message : "unknown"
      });
    }
    const identity: { organizationId?: string; userId?: string; targetId?: string } = {
      organizationId: input.organizationId,
      targetId: input.memoryId
    };
    if (input.actorId) identity.userId = input.actorId;
    this.auditLogger.record(input.action, `memory-${input.memoryId}`, identity);
  }

  private toMemoryRecordValue(row: {
    id: string;
    organizationId: string;
    employeeId: string | null;
    userId: string | null;
    conversationId: string | null;
    scope: string;
    category: string;
    key: string;
    value: Prisma.JsonValue;
    searchableText: string | null;
    confidence: unknown;
    importance: string;
    source: string;
    metadata: Prisma.JsonValue;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): MemoryRecordValue {
    return {
      id: row.id,
      organizationId: row.organizationId,
      employeeId: row.employeeId,
      userId: row.userId,
      conversationId: row.conversationId,
      scope: row.scope as MemoryRecordValue["scope"],
      category: row.category,
      key: row.key,
      value: (row.value ?? {}) as Record<string, unknown>,
      searchableText: row.searchableText,
      confidence: Number(row.confidence),
      importance: row.importance as MemoryRecordValue["importance"],
      source: row.source as MemoryRecordValue["source"],
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt
    };
  }
}

function ownerWhere(input: RememberMemoryInput): Prisma.MemoryRecordWhereInput {
  const where: Prisma.MemoryRecordWhereInput = {
    scope: input.scope as MemoryScope,
    employeeId: input.employeeId ?? null,
    userId: input.userId ?? null,
    conversationId: input.conversationId ?? null,
    key: input.key
  };
  return where;
}

/** Deterministic conversation summarizer: extracted facts + short latest user lines merged with the
 *  previous rolling summary. Keeps important facts (preferences, contacts) while bounding length. */
function buildDeterministicSummary(
  previous: string | null,
  newMessages: Array<{ role: string; content: string }>,
  maxLength: number
): string {
  const lines: string[] = [];
  const facts: string[] = [];
  const recent: string[] = [];
  for (const message of newMessages) {
    if (message.role !== "USER" || !message.content.trim()) continue;
    const extracted = extractMemories(message.content);
    for (const fact of extracted)
      facts.push(
        `${fact.key}: ${typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value)}`
      );
    const compact = message.content.replace(/\s+/g, " ").trim();
    if (compact.length <= 140) recent.push(compact);
  }
  const uniqueFacts = [...new Set(facts)].slice(0, 30);
  if (previous) lines.push(`Earlier context:\n${previous}`);
  if (uniqueFacts.length) lines.push(`Facts:\n${uniqueFacts.map((fact) => `- ${fact}`).join("\n")}`);
  if (recent.length) lines.push(`Latest:\n${recent.map((line) => `- ${line}`).join("\n")}`);
  const joined = lines.join("\n\n");
  return joined.length > maxLength ? `${joined.slice(0, maxLength).trimEnd()}…` : joined;
}
