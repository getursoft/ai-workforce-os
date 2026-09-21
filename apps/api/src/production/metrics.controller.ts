import { Controller, Get } from "@nestjs/common";
import { DiskHealthService } from "./disk-health.service";
import { QueueHealthService } from "../queue/queue-worker";
import { SchedulerWorkerHealth } from "../scheduler/scheduler-worker.health";
import { ObservabilityHealthService } from "../observability/observability-health.service";
import { ObservabilityRetentionService } from "../observability/observability-retention.service";

@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly diskHealth: DiskHealthService,
    private readonly queueHealth: QueueHealthService,
    private readonly schedulerHealth: SchedulerWorkerHealth,
    private readonly observabilityHealth: ObservabilityHealthService,
    private readonly observabilityRetention: ObservabilityRetentionService
  ) {}

  @Get()
  async getMetrics(): Promise<Record<string, unknown>> {
    const disk = this.diskHealth.check();
    const queue = await this.queueHealth.snapshot(new Date());
    const scheduler = this.schedulerHealth.snapshot();
    const observabilityComponents = await this.observabilityHealth.checkAll("platform");
    const retentionLastRun = this.observabilityRetention.getLastRunAt()?.toISOString() ?? null;
    const diskWarning = this.diskHealth.getLastWarningLevel();

    return {
      timestamp: new Date().toISOString(),
      disk: {
        status: disk.status,
        usedPercent: disk.usedPercent,
        warningLevel: diskWarning
      },
      queue: {
        status: queue.status,
        health: queue.health
      },
      scheduler: {
        status: scheduler.status,
        workerId: scheduler.workerId,
        runningJobs: scheduler.runningJobs,
        completedJobs: scheduler.completedJobs,
        failedJobs: scheduler.failedJobs,
        retriedJobs: scheduler.retriedJobs
      },
      observability: { components: observabilityComponents },
      retention: {
        lastRunAt: retentionLastRun,
        status: retentionLastRun ? (Date.now() - new Date(retentionLastRun).getTime() > 3_600_000 ? "STALE" : "HEALTHY") : "NEVER_RUN"
      }
    };
  }
}
