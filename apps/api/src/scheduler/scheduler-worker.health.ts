/**
 * Sprint 4.8 — Worker Health (Phase 10): heartbeat + runtime counters for the background scheduler worker.
 *
 * The scheduler is process-local (single or multiple API instances); each instance exposes a
 * WorkerHealthView so operators can see last poll, running/completed/failed/retried counts, CPU time,
 * memory, and queue latency — all surfaced through the monitoring API and dashboard.
 */

import { Injectable } from "@nestjs/common";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import type { WorkerHealthView } from "./scheduler.types";

@Injectable()
export class SchedulerWorkerHealth {
  readonly workerId: string;
  readonly pid = process.pid;
  readonly startedAt = new Date();

  private lastHeartbeatAt: Date | null = null;
  private lastPollAt: Date | null = null;
  private runningJobs = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private retriedJobs = 0;
  private queueLatencyMs: number | null = null;
  private pollIntervalMs = 5_000;
  private stopped = false;

  constructor() {
    const token = randomBytes(4).toString("hex");
    this.workerId = `scheduler-${hostname()}-${process.pid}-${token}`;
  }

  get lastPoll(): Date | null {
    return this.lastPollAt;
  }

  get workerRunningJobs(): number {
    return this.runningJobs;
  }

  markStarted(pollIntervalMs?: number): void {
    this.pollIntervalMs = pollIntervalMs ?? this.pollIntervalMs;
    this.lastHeartbeatAt = new Date();
  }

  markPoll(): void {
    this.lastPollAt = new Date();
    this.lastHeartbeatAt = new Date();
  }

  markStopped(): void {
    this.stopped = true;
  }

  incrementRunning(): void {
    this.runningJobs += 1;
  }

  decrementRunning(): void {
    this.runningJobs = Math.max(this.runningJobs - 1, 0);
  }

  incrementCompleted(): void {
    this.completedJobs += 1;
  }

  incrementFailed(): void {
    this.failedJobs += 1;
  }

  incrementRetried(): void {
    this.retriedJobs += 1;
  }

  recordQueueLatency(latencyMs: number): void {
    this.queueLatencyMs = latencyMs;
  }

  snapshot(now = new Date()): WorkerHealthView {
    const stale =
      this.lastHeartbeatAt !== null && now.getTime() - this.lastHeartbeatAt.getTime() > 60_000;
    const status: WorkerHealthView["status"] = this.stopped
      ? "STOPPED"
      : this.runningJobs > 0
        ? "RUNNING"
        : stale
          ? "STALE"
          : "IDLE";
    return {
      workerId: this.workerId,
      status,
      pid: this.pid,
      startedAt: this.startedAt.toISOString(),
      lastHeartbeatAt: this.lastHeartbeatAt?.toISOString() ?? null,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      runningJobs: this.runningJobs,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      retriedJobs: this.retriedJobs,
      cpuTimeMs: cpuTimeMs(),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      uptimeSec: Math.round(process.uptime()),
      queueLatencyMs: this.queueLatencyMs,
      pollIntervalMs: this.pollIntervalMs
    };
  }
}

function cpuTimeMs(): number {
  try {
    const usage = process.cpuUsage();
    return Math.round((usage.user + usage.system) / 1000);
  } catch {
    return 0;
  }
}
