import { Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { EmailService } from "../notifications/email.service";
import { ChannelMessageProcessor } from "../channels/channel-message.processor";
import { ObservabilityMetricsService } from "./observability-metrics.service";
import { ObservabilityRetentionService, RETENTION_INTERVAL_MS } from "./observability-retention.service";
import { QueueHealthService } from "../queue/queue-worker";

export type HealthStatus = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";

export interface ComponentHealth {
  component: string;
  status: HealthStatus;
  detail: string;
  latencyMs: number | null;
  checkedAt: string;
}

const BACKGROUND_WORKER_POLL_INTERVAL_MS = 3000;

/**
 * Sprint 4.7A Phase 7: real runtime checks, not a static "the process started successfully" report — every
 * component here either runs a live query/handshake or reads a live in-process heartbeat. A component with
 * nothing to check for this organization (no channels installed, SMTP unconfigured, no connectors
 * installed) reports UNKNOWN rather than a fabricated HEALTHY, since "never used" and "working" are not the
 * same claim.
 */
@Injectable()
export class ObservabilityHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ObservabilityMetricsService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly channelProcessor?: ChannelMessageProcessor,
    @Optional() private readonly retention?: ObservabilityRetentionService,
    @Optional() private readonly queueHealth?: QueueHealthService
  ) {}

  async checkAll(organizationId: string): Promise<ComponentHealth[]> {
    const checks = await Promise.all([
      this.checkApi(),
      this.checkDatabase(),
      this.checkProvider(organizationId),
      this.checkWorkflowEngine(organizationId),
      this.checkBackgroundWorker(),
      this.checkMemory(organizationId),
      this.checkKnowledge(organizationId),
      this.checkChannel(organizationId, "WHATSAPP"),
      this.checkEmail(),
      this.checkScheduler(),
      this.checkConnectorRuntime(organizationId),
      this.checkQueue()
    ]);
    return checks;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private async checkApi(): Promise<ComponentHealth> {
    return { component: "API", status: "HEALTHY", detail: "Request served by this process.", latencyMs: 0, checkedAt: this.now() };
  }

  private async checkDatabase(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const latencyMs = Date.now() - started;
      return {
        component: "Database",
        status: latencyMs > 500 ? "DEGRADED" : "HEALTHY",
        detail: latencyMs > 500 ? `Reachable but slow (${latencyMs}ms).` : "Reachable.",
        latencyMs,
        checkedAt: this.now()
      };
    } catch (error) {
      return { component: "Database", status: "UNHEALTHY", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkProvider(organizationId: string): Promise<ComponentHealth> {
    const started = Date.now();
    const since = new Date(Date.now() - 15 * 60 * 1000);
    try {
      const [total, failed] = await Promise.all([
        this.prisma.agentExecution.count({ where: { organizationId, startedAt: { gte: since } } }),
        this.prisma.agentExecution.count({ where: { organizationId, startedAt: { gte: since }, status: { in: ["FAILED", "TIMED_OUT"] } } })
      ]);
      const latencyMs = Date.now() - started;
      if (total === 0) return { component: "Provider", status: "UNKNOWN", detail: "No executions in the last 15 minutes.", latencyMs, checkedAt: this.now() };
      const failureRate = failed / total;
      return {
        component: "Provider",
        status: failureRate > 0.5 ? "UNHEALTHY" : failureRate > 0.1 ? "DEGRADED" : "HEALTHY",
        detail: `${failed}/${total} executions failed in the last 15 minutes.`,
        latencyMs,
        checkedAt: this.now()
      };
    } catch (error) {
      return { component: "Provider", status: "UNKNOWN", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkWorkflowEngine(organizationId: string): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const stuck = await this.metrics.stuckWorkflows(organizationId);
      const latencyMs = Date.now() - started;
      return {
        component: "Workflow Engine",
        status: stuck.length === 0 ? "HEALTHY" : stuck.length <= 2 ? "DEGRADED" : "UNHEALTHY",
        detail: stuck.length === 0 ? "No stuck workflows." : `${stuck.length} workflow(s) appear stuck.`,
        latencyMs,
        checkedAt: this.now()
      };
    } catch (error) {
      return { component: "Workflow Engine", status: "UNKNOWN", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkBackgroundWorker(): Promise<ComponentHealth> {
    if (!this.channelProcessor) return { component: "Background Worker", status: "UNKNOWN", detail: "Processor not available in this process.", latencyMs: null, checkedAt: this.now() };
    const lastPollAt = this.channelProcessor.getLastPollAt();
    if (!lastPollAt) return { component: "Background Worker", status: "UNKNOWN", detail: "No poll tick recorded yet.", latencyMs: null, checkedAt: this.now() };
    const ageMs = Date.now() - lastPollAt.getTime();
    return {
      component: "Background Worker",
      status: ageMs > BACKGROUND_WORKER_POLL_INTERVAL_MS * 5 ? "UNHEALTHY" : ageMs > BACKGROUND_WORKER_POLL_INTERVAL_MS * 2 ? "DEGRADED" : "HEALTHY",
      detail: `Last poll ${ageMs}ms ago.`,
      latencyMs: ageMs,
      checkedAt: this.now()
    };
  }

  private async checkMemory(organizationId: string): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      await this.prisma.memoryRecord.count({ where: { organizationId, deletedAt: null } });
      return { component: "Memory", status: "HEALTHY", detail: "Reachable.", latencyMs: Date.now() - started, checkedAt: this.now() };
    } catch (error) {
      return { component: "Memory", status: "UNHEALTHY", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkKnowledge(organizationId: string): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      await this.prisma.knowledgeDocument.count({ where: { organizationId, deletedAt: null } });
      return { component: "Knowledge", status: "HEALTHY", detail: "Reachable.", latencyMs: Date.now() - started, checkedAt: this.now() };
    } catch (error) {
      return { component: "Knowledge", status: "UNHEALTHY", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkChannel(organizationId: string, channelType: "WHATSAPP"): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const activeConnections = await this.prisma.channelConnection.count({
        where: { organizationId, channelType, status: "ACTIVE", deletedAt: null }
      });
      if (activeConnections === 0)
        return { component: "WhatsApp", status: "UNKNOWN", detail: "No active connections configured.", latencyMs: Date.now() - started, checkedAt: this.now() };
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [sent, failed] = await Promise.all([
        this.prisma.channelMessage.count({ where: { organizationId, direction: "OUTBOUND", status: "SENT", createdAt: { gte: since } } }),
        this.prisma.channelMessage.count({ where: { organizationId, direction: "OUTBOUND", status: "FAILED", createdAt: { gte: since } } })
      ]);
      const latencyMs = Date.now() - started;
      if (sent + failed === 0) return { component: "WhatsApp", status: "HEALTHY", detail: `${activeConnections} active connection(s), no traffic in 24h.`, latencyMs, checkedAt: this.now() };
      const failureRate = failed / (sent + failed);
      return {
        component: "WhatsApp",
        status: failureRate > 0.5 ? "UNHEALTHY" : failureRate > 0.1 ? "DEGRADED" : "HEALTHY",
        detail: `${failed}/${sent + failed} outbound deliveries failed in the last 24h.`,
        latencyMs,
        checkedAt: this.now()
      };
    } catch (error) {
      return { component: "WhatsApp", status: "UNKNOWN", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkEmail(): Promise<ComponentHealth> {
    const started = Date.now();
    if (!this.email || !this.email.isConfigured())
      return { component: "Email", status: "UNKNOWN", detail: "SMTP not configured.", latencyMs: Date.now() - started, checkedAt: this.now() };
    const ok = await this.email.verifyConnection();
    return {
      component: "Email",
      status: ok ? "HEALTHY" : "UNHEALTHY",
      detail: ok ? "SMTP handshake succeeded." : "SMTP handshake failed.",
      latencyMs: Date.now() - started,
      checkedAt: this.now()
    };
  }

  private async checkScheduler(): Promise<ComponentHealth> {
    if (!this.retention) return { component: "Scheduler", status: "UNKNOWN", detail: "Retention job not available in this process.", latencyMs: null, checkedAt: this.now() };
    const lastRunAt = this.retention.getLastRunAt();
    if (!lastRunAt) return { component: "Scheduler", status: "UNKNOWN", detail: "Retention job has not run yet.", latencyMs: null, checkedAt: this.now() };
    const ageMs = Date.now() - lastRunAt.getTime();
    return {
      component: "Scheduler",
      status: ageMs > RETENTION_INTERVAL_MS * 3 ? "UNHEALTHY" : "HEALTHY",
      detail: `Retention job last ran ${ageMs}ms ago.`,
      latencyMs: ageMs,
      checkedAt: this.now()
    };
  }

  /** Sprint 5.0 Phase 22: durable queue backlog/latency — degraded when messages are stuck past their
   *  visibility lease (stale claims) or the oldest queued message has waited more than 5 minutes. */
  private async checkQueue(): Promise<ComponentHealth> {
    if (!this.queueHealth) return { component: "Background Queue", status: "UNKNOWN", detail: "Queue health service not available in this process.", latencyMs: null, checkedAt: this.now() };
    const started = Date.now();
    try {
      const snapshot = await this.queueHealth.snapshot();
      return {
        component: "Background Queue",
        status: snapshot.status === "DEGRADED" ? "DEGRADED" : "HEALTHY",
        detail: snapshot.detail,
        latencyMs: Date.now() - started,
        checkedAt: this.now()
      };
    } catch (error) {
      return { component: "Background Queue", status: "UNHEALTHY", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }

  private async checkConnectorRuntime(organizationId: string): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const active = await this.prisma.connectorInstallation.count({ where: { organizationId, status: { in: ["READY", "CONNECTED"] } } });
      const latencyMs = Date.now() - started;
      if (active === 0) return { component: "Connector Runtime", status: "UNKNOWN", detail: "No active connectors installed.", latencyMs, checkedAt: this.now() };
      return { component: "Connector Runtime", status: "HEALTHY", detail: `${active} active connector(s) reachable in the registry.`, latencyMs, checkedAt: this.now() };
    } catch (error) {
      return { component: "Connector Runtime", status: "UNKNOWN", detail: safeMessage(error), latencyMs: Date.now() - started, checkedAt: this.now() };
    }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "Unknown error";
}
