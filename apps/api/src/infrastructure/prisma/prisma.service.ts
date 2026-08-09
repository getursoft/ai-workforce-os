import { Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Sprint 5.0 — database hardening (Phase 5).
 *
 * Configures the Prisma client for managed PostgreSQL:
 *  - connection pool size from DATABASE_POOL_MIN/MAX (default 2/10)
 *  - per-statement timeout from DATABASE_STATEMENT_TIMEOUT_MS (safe default 30s) so a slow query can
 *    never pin a pool connection indefinitely
 *  - slow-query logging above DATABASE_SLOW_QUERY_MS (default 500ms)
 *  - graceful shutdown via onModuleDestroy (Nest's shutdown hooks drain in-flight work first)
 *  - retry-safe $connect with bounded attempts + backoff, then clear failure (no silent half-start)
 */

const MAX_CONNECT_ATTEMPTS = 5;
const CONNECT_BACKOFF_MS = 500;

export interface PrismaOptions {
  databaseUrl?: string;
  /** Back-compat alias for databaseUrl used by some test harnesses. */
  datasourceUrl?: string;
  poolMin?: number;
  poolMax?: number;
  statementTimeoutMs?: number;
  slowQueryMs?: number;
  transactionTimeoutMs?: number;
}

type PrismaLogEvent = "query" | "warn" | "error";
type PrismaClientOptionsWithEvents = Prisma.PrismaClientOptions & {
  log: Array<{ emit: "event"; level: PrismaLogEvent }>;
};

export function buildPrismaOptions(input: PrismaOptions): PrismaClientOptionsWithEvents {
  const databaseUrl = input.databaseUrl ?? "";
  const connectionLimit = Math.max(input.poolMin ?? 2, Math.min(input.poolMax ?? 10, 200));
  const url = new URL(databaseUrl || "postgresql://invalid/invalid");
  url.searchParams.set("connection_limit", String(connectionLimit));
  url.searchParams.set("pool_timeout", String(Math.max(input.statementTimeoutMs ?? 30_000, 1000)));
  url.searchParams.set("statement_timeout", String(input.statementTimeoutMs ?? 30_000));
  return {
    datasources: { db: { url: databaseUrl ? url.toString() : databaseUrl } },
    log: [
      { emit: "event", level: "query" },
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" }
    ]
  };
}

@Injectable()
export class PrismaService extends PrismaClient<PrismaClientOptionsWithEvents, PrismaLogEvent> implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly slowQueryMs: number;
  private connected = false;

  // @Optional() so Nest's DI container (which sees a constructor parameter and otherwise tries to resolve
  // it as a dependency) injects `undefined` instead of throwing — `undefined` then triggers the default
  // value below, exactly as a direct `new PrismaService()` call (used by test harnesses) already relies on.
  constructor(@Optional() options: PrismaOptions = { databaseUrl: process.env.DATABASE_URL ?? "" }) {
    const databaseUrl = options.databaseUrl || options.datasourceUrl || process.env.DATABASE_URL || "";
    super(
      buildPrismaOptions({
        ...options,
        databaseUrl,
        poolMin: options.poolMin ?? envInt("DATABASE_POOL_MIN", 2),
        poolMax: options.poolMax ?? envInt("DATABASE_POOL_MAX", 10),
        statementTimeoutMs: options.statementTimeoutMs ?? envInt("DATABASE_STATEMENT_TIMEOUT_MS", 30_000),
        slowQueryMs: options.slowQueryMs ?? envInt("DATABASE_SLOW_QUERY_MS", 500)
      })
    );
    this.slowQueryMs = options.slowQueryMs ?? 500;

    this.$on("query", (event) => {
      if (event.duration >= this.slowQueryMs) {
        this.logger.warn({
          event: "SLOW_QUERY",
          durationMs: event.duration,
          query: String(event.query).slice(0, 400),
          params: String(event.params).slice(0, 200)
        });
      }
    });
    this.$on("error", (event) => {
      this.logger.error({ event: "PRISMA_CLIENT_ERROR", message: event.message });
    });
    this.$on("warn", (event) => {
      this.logger.warn({ event: "PRISMA_CLIENT_WARN", message: event.message });
    });
  }

  /** Connects with bounded retry for transient startup failures; fails loudly once exhausted. */
  async onModuleInit(): Promise<void> {
    let attempts = 0;
    let lastError: unknown;
    while (attempts < MAX_CONNECT_ATTEMPTS) {
      try {
        await this.$connect();
        this.connected = true;
        this.logger.log({ event: "DATABASE_CONNECTED" });
        return;
      } catch (error) {
        lastError = error;
        attempts += 1;
        this.logger.warn({
          event: "DATABASE_CONNECT_RETRY",
          attempt: attempts,
          maxAttempts: MAX_CONNECT_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error)
        });
        await new Promise((resolve) => setTimeout(resolve, CONNECT_BACKOFF_MS * attempts));
      }
    }
    this.logger.error({ event: "DATABASE_CONNECT_FAILED", error: lastError instanceof Error ? lastError.message : String(lastError) });
    throw lastError ?? new Error("DATABASE_CONNECT_FAILED");
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful: wait briefly for in-flight work to drain before closing the pool.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (this.connected) {
      await this.$disconnect();
      this.connected = false;
    }
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
