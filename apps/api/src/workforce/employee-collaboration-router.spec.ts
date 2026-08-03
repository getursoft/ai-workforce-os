import { describe, expect, it, vi } from "vitest";
import { EmployeeCollaborationRouter } from "./employee-collaboration-router";
import type { WorkforceEmployee } from "./employee-registry";
import type { DelegationContract } from "./delegation-contract";

function employee(overrides: Partial<WorkforceEmployee> = {}): WorkforceEmployee {
  return {
    installationId: "target-1",
    displayName: "Finance Employee",
    pluginSlug: "finance-employee",
    status: "ACTIVE",
    employeeType: "FINANCE",
    routingDomains: ["Finance"],
    aliases: ["finance", "expense", "invoice", "budget"],
    capabilities: ["finance.chat", "CRM"],
    grantedPermissions: ["LLM", "MEMORY", "TOOLS", "CRM"],
    availableTools: ["finance.create_record"],
    supportedWorkflowTypes: [],
    knowledgeScope: { collections: 0, hasKnowledge: false },
    collaboration: {
      enabled: true,
      priority: 0,
      supportsSynchronous: true,
      supportsAsynchronous: false,
      maximumExecutionTimeMs: 30_000,
      supportedTaskTypes: ["EXPENSE_CLASSIFICATION", "INVOICE_SUPPORT", "GENERAL_QUERY"],
      requiredCapabilities: ["LLM"],
      sensitiveActions: [],
      defaultFailureBehaviour: "FAIL_PARENT"
    },
    ...overrides
  };
}

function contract(overrides: Partial<DelegationContract> = {}): DelegationContract {
  return { taskType: "INVOICE_SUPPORT", objective: "Check the invoice amount", input: {}, ...overrides };
}

function makeRouter(employees: WorkforceEmployee[]) {
  const registry = { listInstalled: vi.fn().mockResolvedValue(employees) };
  return new EmployeeCollaborationRouter(registry as never);
}

describe("EmployeeCollaborationRouter", () => {
  it("selects the installed employee whose declared task type matches", async () => {
    const target = employee();
    const router = makeRouter([employee({ installationId: "source-1", displayName: "Travel Employee" }), target]);
    const result = await router.route("org-1", "source-1", contract());
    expect(result.shouldDelegate).toBe(true);
    expect(result.targetEmployeeInstallationId).toBe("target-1");
    expect(result.reasonCode).toBe("TASK_TYPE_MATCH");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("never selects the source itself, even if it is the only other candidate is worse", async () => {
    const source = employee({ installationId: "source-1", collaboration: { ...employee().collaboration, supportedTaskTypes: ["INVOICE_SUPPORT"] } });
    const router = makeRouter([source]);
    const result = await router.route("org-1", "source-1", contract());
    expect(result.shouldDelegate).toBe(false);
    expect(result.targetEmployeeInstallationId).toBeNull();
  });

  it("rejects an installed-but-inactive candidate", async () => {
    const target = employee({ status: "DISABLED" });
    const router = makeRouter([employee({ installationId: "source-1" }), target]);
    const result = await router.route("org-1", "source-1", contract());
    expect(result.shouldDelegate).toBe(false);
  });

  it("falls back to capability match when no task type matches, but never below the confidence threshold for an unrelated employee", async () => {
    const target = employee({ capabilities: ["finance.chat", "CRM"], collaboration: { ...employee().collaboration, supportedTaskTypes: [] } });
    const router = makeRouter([employee({ installationId: "source-1" }), target]);
    const result = await router.route("org-1", "source-1", contract({ taskType: "SOMETHING_ELSE", targetCapability: "finance.chat" }));
    expect(result.shouldDelegate).toBe(true);
    expect(result.reasonCode).toBe("CAPABILITY_MATCH");
  });

  it("returns low confidence / no delegation for a completely unrelated request", async () => {
    const target = employee({
      displayName: "Legal Employee",
      routingDomains: ["Legal"],
      aliases: ["legal", "notice", "compliance"],
      capabilities: ["legal.chat"],
      collaboration: { ...employee().collaboration, supportedTaskTypes: ["NOTICE_SUMMARISATION"] }
    });
    const router = makeRouter([employee({ installationId: "source-1" }), target]);
    const result = await router.route("org-1", "source-1", contract({ taskType: "UNRELATED_TASK", objective: "Completely unrelated request about spaceships" }));
    expect(result.shouldDelegate).toBe(false);
    expect(result.reasonCode).toBe("NO_ELIGIBLE_EMPLOYEE");
  });

  it("respects an explicit allow-list — an otherwise-eligible employee outside the list is excluded", async () => {
    const target = employee({ installationId: "target-1" });
    const otherTarget = employee({ installationId: "target-2", displayName: "Finance Employee 2" });
    const router = makeRouter([employee({ installationId: "source-1" }), target, otherTarget]);
    const result = await router.route("org-1", "source-1", contract(), { allowedTargetEmployeeIds: ["target-2"] });
    expect(result.targetEmployeeInstallationId).toBe("target-2");
  });

  it("does not select a target with collaboration disabled even on a perfect task-type match", async () => {
    const target = employee({ collaboration: { ...employee().collaboration, enabled: false } });
    const router = makeRouter([employee({ installationId: "source-1" }), target]);
    const result = await router.route("org-1", "source-1", contract());
    expect(result.shouldDelegate).toBe(false);
    expect(result.reasonCode).toBe("DELEGATION_DISABLED_FOR_TARGET");
  });

  it("never routes to an employee based on display name alone when no task/capability/domain signal matches", async () => {
    const target = employee({
      displayName: "Finance Employee",
      routingDomains: [],
      aliases: [],
      capabilities: [],
      collaboration: { ...employee().collaboration, supportedTaskTypes: [] }
    });
    const router = makeRouter([employee({ installationId: "source-1" }), target]);
    const result = await router.route("org-1", "source-1", contract({ taskType: "FINANCE_QUESTION", objective: "finance please help" }));
    // "finance" appears in the objective and the display name, but neither is a declared signal —
    // display name is never itself part of the scoring haystack.
    expect(result.shouldDelegate).toBe(false);
  });
});
