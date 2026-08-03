import { Injectable } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

export interface WorkforceCollaborationPolicyData {
  collaborationEnabled: boolean;
  maximumDelegationDepth: number;
  maximumTasksPerParentExecution: number;
  allowedSourceEmployeeIds: string[];
  allowedTargetEmployeeIds: string[];
  allowedTaskTypes: string[];
  crossEmployeeMemorySharingMode: string;
  requireApprovalForSensitiveDelegation: boolean;
  delegationTimeoutMs: number;
  retryLimit: number;
  allowParallelDelegation: boolean;
  exposeDelegationToUser: boolean;
}

export interface UpdateWorkforceCollaborationPolicyInput {
  collaborationEnabled?: boolean;
  maximumDelegationDepth?: number;
  maximumTasksPerParentExecution?: number;
  allowedSourceEmployeeIds?: string[];
  allowedTargetEmployeeIds?: string[];
  allowedTaskTypes?: string[];
  crossEmployeeMemorySharingMode?: string;
  requireApprovalForSensitiveDelegation?: boolean;
  delegationTimeoutMs?: number;
  retryLimit?: number;
  allowParallelDelegation?: boolean;
  exposeDelegationToUser?: boolean;
}

/** Sprint 4.6 Phase 7 — organization-level collaboration policy, created lazily with safe defaults on
 *  first read (same lifecycle pattern used for OrganizationSetting). */
@Injectable()
export class WorkforceCollaborationPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(organizationId: string): Promise<WorkforceCollaborationPolicyData> {
    const row = await this.prisma.workforceCollaborationPolicy.upsert({
      where: { organizationId },
      update: {},
      create: { organizationId }
    });
    return this.toData(row);
  }

  async update(
    organizationId: string,
    input: UpdateWorkforceCollaborationPolicyInput
  ): Promise<WorkforceCollaborationPolicyData> {
    await this.getOrCreate(organizationId);
    const row = await this.prisma.workforceCollaborationPolicy.update({
      where: { organizationId },
      data: {
        ...(input.collaborationEnabled !== undefined ? { collaborationEnabled: input.collaborationEnabled } : {}),
        ...(input.maximumDelegationDepth !== undefined ? { maximumDelegationDepth: input.maximumDelegationDepth } : {}),
        ...(input.maximumTasksPerParentExecution !== undefined
          ? { maximumTasksPerParentExecution: input.maximumTasksPerParentExecution }
          : {}),
        ...(input.allowedSourceEmployeeIds !== undefined
          ? { allowedSourceEmployeeIds: input.allowedSourceEmployeeIds }
          : {}),
        ...(input.allowedTargetEmployeeIds !== undefined
          ? { allowedTargetEmployeeIds: input.allowedTargetEmployeeIds }
          : {}),
        ...(input.allowedTaskTypes !== undefined ? { allowedTaskTypes: input.allowedTaskTypes } : {}),
        ...(input.crossEmployeeMemorySharingMode !== undefined
          ? { crossEmployeeMemorySharingMode: input.crossEmployeeMemorySharingMode }
          : {}),
        ...(input.requireApprovalForSensitiveDelegation !== undefined
          ? { requireApprovalForSensitiveDelegation: input.requireApprovalForSensitiveDelegation }
          : {}),
        ...(input.delegationTimeoutMs !== undefined ? { delegationTimeoutMs: input.delegationTimeoutMs } : {}),
        ...(input.retryLimit !== undefined ? { retryLimit: input.retryLimit } : {}),
        ...(input.allowParallelDelegation !== undefined
          ? { allowParallelDelegation: input.allowParallelDelegation }
          : {}),
        ...(input.exposeDelegationToUser !== undefined ? { exposeDelegationToUser: input.exposeDelegationToUser } : {})
      }
    });
    return this.toData(row);
  }

  private toData(row: {
    collaborationEnabled: boolean;
    maximumDelegationDepth: number;
    maximumTasksPerParentExecution: number;
    allowedSourceEmployeeIds: unknown;
    allowedTargetEmployeeIds: unknown;
    allowedTaskTypes: unknown;
    crossEmployeeMemorySharingMode: string;
    requireApprovalForSensitiveDelegation: boolean;
    delegationTimeoutMs: number;
    retryLimit: number;
    allowParallelDelegation: boolean;
    exposeDelegationToUser: boolean;
  }): WorkforceCollaborationPolicyData {
    return {
      collaborationEnabled: row.collaborationEnabled,
      maximumDelegationDepth: row.maximumDelegationDepth,
      maximumTasksPerParentExecution: row.maximumTasksPerParentExecution,
      allowedSourceEmployeeIds: asStringArray(row.allowedSourceEmployeeIds),
      allowedTargetEmployeeIds: asStringArray(row.allowedTargetEmployeeIds),
      allowedTaskTypes: asStringArray(row.allowedTaskTypes),
      crossEmployeeMemorySharingMode: row.crossEmployeeMemorySharingMode,
      requireApprovalForSensitiveDelegation: row.requireApprovalForSensitiveDelegation,
      delegationTimeoutMs: row.delegationTimeoutMs,
      retryLimit: row.retryLimit,
      allowParallelDelegation: row.allowParallelDelegation,
      exposeDelegationToUser: row.exposeDelegationToUser
    };
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
