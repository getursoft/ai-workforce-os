import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";

export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 500;

/**
 * Sprint 4.7A Phase 11: deletes old ExecutionTrace/ExecutionSpan rows per each organization's own
 * ObservabilitySettings.successTraceRetentionDays/errorTraceRetentionDays. No external scheduler
 * infrastructure — same in-process `setInterval` pattern already used by ChannelMessageProcessor (see
 * that file's own doc comment for why). Never touches AuditEvent, AgentExecution, WorkflowExecution,
 * EmployeeDelegatedTask, or UsageEvent — only the two tables this pass introduced. Spans are deleted before
 * their parent trace (FK-safe ordering, though there is no DB-level FK from span to trace by design).
 */
@Injectable()
export class ObservabilityRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObservabilityRetentionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private lastRunAt: Date | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  onModuleInit() {
    if (this.security.nodeEnvironment === "test") return;
    this.timer = setInterval(() => void this.runOnce(), RETENTION_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  getLastRunAt(): Date | null {
    return this.lastRunAt;
  }

  async runOnce(): Promise<{ tracesDeleted: number; spansDeleted: number }> {
    if (this.running) return { tracesDeleted: 0, spansDeleted: 0 };
    this.running = true;
    let tracesDeleted = 0;
    let spansDeleted = 0;
    try {
      const organizations = await this.prisma.observabilitySettings.findMany({ select: { organizationId: true, successTraceRetentionDays: true, errorTraceRetentionDays: true } });
      // An organization with no ObservabilitySettings row yet still gets the documented defaults (7 days
      // success / 30 days error — see schema.prisma) so retention isn't silently skipped for it.
      const orgIds = new Set(organizations.map((o) => o.organizationId));
      const withoutSettings = await this.prisma.organization.findMany({
        where: { id: { notIn: [...orgIds] } },
        select: { id: true }
      });
      const plans = [
        ...organizations.map((o) => ({ organizationId: o.organizationId, successDays: o.successTraceRetentionDays, errorDays: o.errorTraceRetentionDays })),
        ...withoutSettings.map((o) => ({ organizationId: o.id, successDays: 7, errorDays: 30 }))
      ];
      for (const plan of plans) {
        const result = await this.cleanupOrganization(plan.organizationId, plan.successDays, plan.errorDays);
        tracesDeleted += result.tracesDeleted;
        spansDeleted += result.spansDeleted;
      }
      this.lastRunAt = new Date();
      this.logger.log({ event: "OBSERVABILITY_RETENTION_RUN", tracesDeleted, spansDeleted, organizations: plans.length });
      return { tracesDeleted, spansDeleted };
    } catch (error) {
      this.logger.warn({ event: "OBSERVABILITY_RETENTION_RUN_FAILED", error: error instanceof Error ? error.message : String(error) });
      return { tracesDeleted, spansDeleted };
    } finally {
      this.running = false;
    }
  }

  private async cleanupOrganization(organizationId: string, successDays: number, errorDays: number): Promise<{ tracesDeleted: number; spansDeleted: number }> {
    const successCutoff = new Date(Date.now() - successDays * 24 * 60 * 60 * 1000);
    const errorCutoff = new Date(Date.now() - errorDays * 24 * 60 * 60 * 1000);
    let tracesDeleted = 0;
    let spansDeleted = 0;
    // Two passes (COMPLETED vs FAILED) since each status has its own retention window. RUNNING traces are
    // never deleted by age alone — a stuck/abandoned RUNNING trace is exactly what the alert/error explorer
    // needs to keep showing, not silently garbage-collect.
    for (const [status, cutoff] of [
      ["COMPLETED", successCutoff],
      ["FAILED", errorCutoff]
    ] as const) {
      const expired = await this.prisma.executionTrace.findMany({
        where: { organizationId, status, completedAt: { lt: cutoff } },
        select: { traceId: true },
        take: RETENTION_BATCH_SIZE
      });
      if (!expired.length) continue;
      const traceIds = expired.map((t) => t.traceId);
      const spanResult = await this.prisma.executionSpan.deleteMany({ where: { organizationId, traceId: { in: traceIds } } });
      const traceResult = await this.prisma.executionTrace.deleteMany({ where: { organizationId, traceId: { in: traceIds }, status } });
      spansDeleted += spanResult.count;
      tracesDeleted += traceResult.count;
    }
    return { tracesDeleted, spansDeleted };
  }
}
