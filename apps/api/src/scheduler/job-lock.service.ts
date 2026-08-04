/**
 * Sprint 4.8 — Job Locking (Phase 6).
 *
 * Every ScheduledJob is claimed through a JobLock row (unique per jobId) before a worker creates an
 * execution for it. Acquire is atomic: a fresh job is claimed by inserting the lock row; an existing
 * lock is only taken over when its lease has expired (a crashed worker) via an optimistic
 * `version`-guarded update. This guarantees exactly-once dispatch even when multiple API instances
 * poll the same queue.
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

export interface JobLockInfo {
  jobId: string;
  organizationId: string;
  workerId: string;
  version: number;
  leaseExpiresAt: Date;
  lockedAt: Date;
}

@Injectable()
export class JobLockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempts to claim the lock for `jobId` under `workerId` for `leaseMs` milliseconds.
   * Returns true exactly once per lease — every other concurrent caller (including a second worker
   * instance polling the same job) gets false.
   */
  async acquire(
    jobId: string,
    organizationId: string,
    workerId: string,
    leaseMs: number
  ): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    try {
      await this.prisma.jobLock.create({
        data: { jobId, organizationId, workerId, version: 0, leaseExpiresAt }
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const lock = await this.prisma.jobLock.findUnique({ where: { jobId } });
    if (!lock) return false;
    const expired = lock.leaseExpiresAt.getTime() < now.getTime();
    const sameWorker = lock.workerId === workerId;
    if (!expired && !sameWorker) return false; // held by a live worker — never steal
    const result = await this.prisma.jobLock.updateMany({
      where: { id: lock.id, version: lock.version },
      data: { workerId, leaseExpiresAt, lockedAt: new Date(), version: { increment: 1 } }
    });
    return result.count === 1;
  }

  /** Heartbeat — extends the lease for a lock this worker owns. */
  async renew(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const now = new Date();
    const result = await this.prisma.jobLock.updateMany({
      where: { jobId, workerId },
      data: { leaseExpiresAt: new Date(now.getTime() + leaseMs), version: { increment: 1 } }
    });
    return result.count === 1;
  }

  /** Releases the lock so the next dispatch can claim it — only when owned by this worker. */
  async release(jobId: string, workerId: string): Promise<boolean> {
    const result = await this.prisma.jobLock.deleteMany({ where: { jobId, workerId } });
    return result.count === 1;
  }

  /** Reads the current lock state for a job (null when never locked). */
  async get(jobId: string): Promise<JobLockInfo | null> {
    const lock = await this.prisma.jobLock.findUnique({ where: { jobId } });
    if (!lock) return null;
    return {
      jobId: lock.jobId,
      organizationId: lock.organizationId,
      workerId: lock.workerId,
      version: lock.version,
      leaseExpiresAt: lock.leaseExpiresAt,
      lockedAt: lock.lockedAt
    };
  }

  /** Locks whose lease has expired — these belonged to a crashed/stopped worker. */
  async listExpired(now = new Date()): Promise<JobLockInfo[]> {
    const locks = await this.prisma.jobLock.findMany({
      where: { leaseExpiresAt: { lt: now } },
      take: 100
    });
    return locks.map((lock) => ({
      jobId: lock.jobId,
      organizationId: lock.organizationId,
      workerId: lock.workerId,
      version: lock.version,
      leaseExpiresAt: lock.leaseExpiresAt,
      lockedAt: lock.lockedAt
    }));
  }

  /** Deletes a lock row outright (used when a job is cancelled/completed). */
  async delete(jobId: string): Promise<void> {
    await this.prisma.jobLock.deleteMany({ where: { jobId } }).catch(() => undefined);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
