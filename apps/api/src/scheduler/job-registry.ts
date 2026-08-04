/**
 * Sprint 4.8 — Job Registry (Phase 1): definition catalog + handler lookup.
 *
 * The registry seeds the job_definitions table (lazily, from the built-in catalog) and resolves a
 * definitionKey → its JobHandler. Plugin authors extend the platform by registering handlers here; they
 * never modify the engine.
 */

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { JOB_DEFINITION_SEEDS } from "./autonomous-job-definitions";
import type { JobHandler, JobHandlerType } from "./scheduler.types";

export interface ResolvedJobDefinition {
  key: string;
  handlerType: JobHandlerType;
  retryPolicy: string;
  maxRetry: number;
  timeoutMs: number;
  eventName: string | null;
}

@Injectable()
export class JobRegistry {
  private handlers: Record<string, JobHandler> = {};

  constructor(private readonly prisma: PrismaService) {}

  /** Upserts the built-in definition catalog into the job_definitions table. */
  async ensureDefinitions(): Promise<void> {
    for (const seed of JOB_DEFINITION_SEEDS) {
      await this.prisma.jobDefinition.upsert({
        where: { key: seed.key },
        create: {
          key: seed.key,
          name: seed.name,
          description: seed.description,
          category: seed.category,
          handlerType: seed.handlerType,
          retryPolicy: seed.retryPolicy,
          maxRetry: seed.maxRetry,
          timeoutMs: seed.timeoutMs ?? 30_000,
          eventName: seed.eventName ?? null,
          enabled: true
        },
        update: {
          name: seed.name,
          description: seed.description,
          category: seed.category,
          handlerType: seed.handlerType,
          retryPolicy: seed.retryPolicy,
          maxRetry: seed.maxRetry,
          timeoutMs: seed.timeoutMs ?? 30_000,
          eventName: seed.eventName ?? null,
          enabled: true
        }
      });
    }
  }

  /** Registers handler implementations keyed by definitionKey (called once at startup). */
  register(handlers: Record<string, JobHandler>): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /** Loads a definition's runtime config from the database. */
  async resolve(key: string): Promise<ResolvedJobDefinition | null> {
    const row = await this.prisma.jobDefinition.findUnique({ where: { key } });
    if (!row) return null;
    return {
      key: row.key,
      handlerType: row.handlerType as JobHandlerType,
      retryPolicy: row.retryPolicy,
      maxRetry: row.maxRetry,
      timeoutMs: row.timeoutMs,
      eventName: row.eventName
    };
  }

  getHandler(key: string): JobHandler | null {
    return this.handlers[key] ?? null;
  }

  /** Lists definitions (used by the API/dashboard). */
  async list(enabledOnly = true): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.jobDefinition.findMany({
      where: enabledOnly ? { enabled: true } : {},
      orderBy: { category: "asc" }
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      category: row.category,
      handlerType: row.handlerType,
      retryPolicy: row.retryPolicy,
      maxRetry: row.maxRetry,
      timeoutMs: row.timeoutMs,
      eventName: row.eventName,
      enabled: row.enabled
    }));
  }
}
