import { Injectable } from "@nestjs/common";
import { EmployeeRegistry, type WorkforceEmployee } from "./employee-registry";
import type { DelegationContract } from "./delegation-contract";

export interface DelegationRoutingAlternative {
  installationId: string;
  displayName: string;
  confidence: number;
}

export interface DelegationRoutingResult {
  shouldDelegate: boolean;
  targetEmployeeInstallationId: string | null;
  taskType: string;
  confidence: number;
  reasonCode:
    | "TASK_TYPE_MATCH"
    | "CAPABILITY_MATCH"
    | "DOMAIN_KEYWORD_MATCH"
    | "NO_ELIGIBLE_EMPLOYEE"
    | "LOW_CONFIDENCE"
    | "DELEGATION_DISABLED_FOR_TARGET"
    | "NOT_ALLOWED_BY_POLICY";
  alternatives: DelegationRoutingAlternative[];
}

const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Sprint 4.6 Phase 6 — routes a delegation contract to an eligible, installed employee in the same
 * organization. Every candidate comes from EmployeeRegistry (i.e. actually installed, actually active,
 * actually configured) — nothing here is name-based or hardcoded. A candidate is never selected because of
 * its display name; it is scored purely on task-type/capability/domain overlap with the delegation
 * contract.
 */
@Injectable()
export class EmployeeCollaborationRouter {
  constructor(private readonly registry: EmployeeRegistry) {}

  async route(
    organizationId: string,
    sourceEmployeeInstallationId: string,
    contract: DelegationContract,
    options: { allowedTargetEmployeeIds?: readonly string[] } = {}
  ): Promise<DelegationRoutingResult> {
    const employees = await this.registry.listInstalled(organizationId);
    const allowList = new Set(options.allowedTargetEmployeeIds ?? []);

    const eligible = employees
      .filter((employee) => employee.installationId !== sourceEmployeeInstallationId)
      .filter((employee) => employee.status === "ACTIVE")
      .filter((employee) => allowList.size === 0 || allowList.has(employee.installationId));
    const anyEligibleButDisabled = eligible.length > 0 && eligible.every((employee) => !employee.collaboration.enabled);

    const scored = eligible
      .filter((employee) => employee.collaboration.enabled)
      .map((employee) => ({ employee, score: this.score(employee, contract) }))
      .sort(
        (a, b) => b.score.confidence - a.score.confidence || b.employee.collaboration.priority - a.employee.collaboration.priority
      );

    const alternatives: DelegationRoutingAlternative[] = scored
      .slice(1, 4)
      .filter(({ score }) => score.confidence > 0)
      .map(({ employee, score }) => ({
        installationId: employee.installationId,
        displayName: employee.displayName,
        confidence: score.confidence
      }));

    const best = scored[0];
    if (!best || best.score.confidence <= 0) {
      return {
        shouldDelegate: false,
        targetEmployeeInstallationId: null,
        taskType: contract.taskType,
        confidence: 0,
        reasonCode: anyEligibleButDisabled ? "DELEGATION_DISABLED_FOR_TARGET" : "NO_ELIGIBLE_EMPLOYEE",
        alternatives
      };
    }
    if (best.score.confidence < CONFIDENCE_THRESHOLD) {
      return {
        shouldDelegate: false,
        targetEmployeeInstallationId: null,
        taskType: contract.taskType,
        confidence: best.score.confidence,
        reasonCode: "LOW_CONFIDENCE",
        alternatives
      };
    }
    return {
      shouldDelegate: true,
      targetEmployeeInstallationId: best.employee.installationId,
      taskType: contract.taskType,
      confidence: best.score.confidence,
      reasonCode: best.score.reasonCode,
      alternatives
    };
  }

  /** Callers only pass employees that already passed the collaboration.enabled pre-filter in route(). */
  private score(
    employee: WorkforceEmployee,
    contract: DelegationContract
  ): { confidence: number; reasonCode: DelegationRoutingResult["reasonCode"] } {
    const taskType = contract.taskType.toUpperCase();
    if (employee.collaboration.supportedTaskTypes.map((t) => t.toUpperCase()).includes(taskType)) {
      return { confidence: 0.95, reasonCode: "TASK_TYPE_MATCH" };
    }

    if (contract.targetCapability) {
      const cap = contract.targetCapability.toUpperCase();
      const has =
        employee.capabilities.some((c) => c.toUpperCase() === cap) ||
        employee.grantedPermissions.some((p) => p.toUpperCase() === cap) ||
        (employee.employeeType ?? "").toUpperCase() === cap;
      if (has) return { confidence: 0.8, reasonCode: "CAPABILITY_MATCH" };
    }

    // Deliberately excludes displayName — an employee is never selected because its name happens to
    // appear in the request text (Phase 6: "Do not route to an employee solely because of its display
    // name"). Only declared routing signals (aliases/domains/type) participate in this match.
    const haystack = [...employee.aliases, ...employee.routingDomains, employee.employeeType ?? ""]
      .join(" ")
      .toLowerCase();
    const needle = `${contract.objective} ${contract.taskType} ${contract.targetCapability ?? ""}`.toLowerCase();
    const domainWords = employee.routingDomains.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
    const keywordHit = domainWords.some((word) => word.length > 2 && needle.includes(word)) || haystack.includes(needle.trim());
    if (keywordHit) return { confidence: 0.65, reasonCode: "DOMAIN_KEYWORD_MATCH" };

    return { confidence: 0, reasonCode: "NO_ELIGIBLE_EMPLOYEE" };
  }
}
