import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service";

export type ApproverType =
  | "CUSTOMER" | "EMPLOYEE" | "MANAGER" | "ORGANISATION_ADMIN"
  | "FINANCE_APPROVER" | "HR_APPROVER" | "SYSTEM_OWNER"
  | "SPECIFIC_USER" | "SPECIFIC_ROLE" | "EXTERNAL_CONTACT" | "MULTI_APPROVER";

export type ApprovalMode =
  | "SINGLE" | "ANY_ONE" | "ALL" | "SEQUENTIAL" | "THRESHOLD" | "CUSTOMER_CONFIRMATION";

export interface PolicyResolutionInput {
  organizationId: string;
  workflowType: string;
  actionType: string;
  subjectType?: string;
  subjectId?: string;
  requesterType?: string;
  requesterId?: string;
  amount?: number;
  currency?: string;
  metadata: Record<string, unknown> | null;
}

export interface PolicyResolutionResult {
  approvalRequired: boolean;
  policyId: string;
  approverType: ApproverType;
  approverIds: string[];
  approverRoleKeys: string[];
  mode: ApprovalMode;
  minimumApprovals: number;
  sequence: string[];
  expiresAt: Date | null;
  reapprovalRules: Record<string, unknown>;
  escalationRules: Record<string, unknown>;
}

const DEFAULT_EXPIRY_HOURS: Record<string, number> = {
  TRAVEL_BOOKING: 48,
  TRAVEL_CANCELLATION: 24,
  HR_LEAVE_REQUEST: 72,
};

@Injectable()
export class ApprovalPolicyEngine {
  private readonly logger = new Logger(ApprovalPolicyEngine.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: PolicyResolutionInput): Promise<PolicyResolutionResult> {
    const policy = await this.prisma.approvalPolicy.findFirst({
      where: {
        organizationId: input.organizationId,
        workflowType: input.workflowType,
        actionType: input.actionType,
        active: true,
      },
    });

    if (!policy) {
      return this.defaultPolicy(input);
    }

    const approverType = policy.approverType as ApproverType;
    const { approverIds, approverRoleKeys } = await this.resolveApprovers(
      approverType,
      input
    );

    const expiresAt = this.computeExpiry(input.workflowType);

    return {
      approvalRequired: true,
      policyId: policy.id,
      approverType,
      approverIds,
      approverRoleKeys,
      mode: policy.mode as ApprovalMode,
      minimumApprovals: policy.minimumApprovals,
      sequence: [],
      expiresAt,
      reapprovalRules: policy.reapprovalRulesJson as Record<string, unknown>,
      escalationRules: policy.escalationRulesJson as Record<string, unknown>,
    };
  }

  private async defaultPolicy(
    input: PolicyResolutionInput
  ): Promise<PolicyResolutionResult> {
    this.logger.warn({
      event: "APPROVAL_POLICY_NOT_FOUND",
      organizationId: input.organizationId,
      workflowType: input.workflowType,
      actionType: input.actionType,
    });

    const approverType: ApproverType =
      input.actionType === "BOOKING" ? "CUSTOMER" : "MANAGER";

    return {
      approvalRequired: true,
      policyId: "builtin:default",
      approverType,
      approverIds: [],
      approverRoleKeys: [],
      mode: approverType === "CUSTOMER" ? "CUSTOMER_CONFIRMATION" : "SINGLE",
      minimumApprovals: 1,
      sequence: [],
      expiresAt: this.computeExpiry(input.workflowType),
      reapprovalRules: { priceTolerancePercent: 5 },
      escalationRules: {},
    };
  }

  private async resolveApprovers(
    approverType: ApproverType,
    input: PolicyResolutionInput
  ): Promise<{ approverIds: string[]; approverRoleKeys: string[] }> {
    const approverIds: string[] = [];
    const approverRoleKeys: string[] = [];

    switch (approverType) {
      case "CUSTOMER":
        break;
      case "MANAGER": {
        if (input.metadata?.managerUserId) {
          approverIds.push(input.metadata.managerUserId as string);
        }
        approverRoleKeys.push("manager");
        break;
      }
      case "ORGANISATION_ADMIN":
        approverRoleKeys.push("admin", "owner");
        break;
      case "FINANCE_APPROVER":
        approverRoleKeys.push("finance_approver");
        break;
      case "HR_APPROVER":
        approverRoleKeys.push("hr_approver");
        break;
      case "SYSTEM_OWNER":
        approverRoleKeys.push("system_owner");
        break;
      case "SPECIFIC_USER":
        if (input.metadata?.approverUserId) {
          approverIds.push(input.metadata.approverUserId as string);
        }
        break;
      case "SPECIFIC_ROLE":
        if (input.metadata?.approverRoleKey) {
          approverRoleKeys.push(input.metadata.approverRoleKey as string);
        }
        break;
      case "EMPLOYEE":
        if (input.requesterId) {
          approverIds.push(input.requesterId);
        }
        break;
      case "MULTI_APPROVER": {
        const userIds = input.metadata?.approverUserIds;
        if (Array.isArray(userIds)) approverIds.push(...userIds.map(String));
        const roleKeys = input.metadata?.approverRoleKeys;
        if (Array.isArray(roleKeys)) approverRoleKeys.push(...roleKeys.map(String));
        break;
      }
      case "EXTERNAL_CONTACT":
        break;
    }

    return { approverIds, approverRoleKeys };
  }

  private computeExpiry(workflowType: string): Date | null {
    const hours = DEFAULT_EXPIRY_HOURS[workflowType] ?? 48;
    const expiry = new Date();
    expiry.setHours(expiry.getHours() + hours);
    return expiry;
  }
}
