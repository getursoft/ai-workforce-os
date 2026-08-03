import type { ApiClient } from "../../lib/api-client";

export interface WorkforceEmployee {
  installationId: string;
  displayName: string;
  pluginSlug: string;
  status: string;
  employeeType: string | null;
  routingDomains: string[];
  aliases: string[];
  capabilities: string[];
  grantedPermissions: string[];
  availableTools: string[];
  supportedWorkflowTypes: string[];
  knowledgeScope: { collections: number; hasKnowledge: boolean };
  collaboration: {
    enabled: boolean;
    priority: number;
    supportsSynchronous: boolean;
    supportsAsynchronous: boolean;
    maximumExecutionTimeMs: number;
    supportedTaskTypes: string[];
    requiredCapabilities: string[];
    sensitiveActions: string[];
    defaultFailureBehaviour: string;
  };
}

export interface DelegatedTask {
  id: string;
  organizationId: string;
  sourceEmployeeInstallationId: string;
  targetEmployeeInstallationId: string;
  taskType: string;
  title: string;
  status: string;
  mode: string;
  priority: number;
  correlationId: string;
  delegationDepth: number;
  attemptCount: number;
  maxAttempts: number;
  resultSummary: string | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  parentWorkflowExecutionId: string | null;
}

export interface DelegatedTaskTimeline {
  taskId: string;
  status: string;
  events: Array<{ step: string; at: string | null }>;
}

export interface CollaborationPolicy {
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

export interface DelegateTaskInput {
  sourceEmployeeInstallationId: string;
  targetEmployeeInstallationId?: string;
  taskType: string;
  targetCapability?: string;
  objective: string;
  input: Record<string, unknown>;
  expectedOutput?: Record<string, unknown>;
  constraints?: { readOnly?: boolean; requiresApproval?: boolean; timeoutMs?: number };
  mode?: "SYNCHRONOUS" | "ASYNCHRONOUS";
  idempotencyKey?: string;
}

function qs(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function createWorkforceApi(client: ApiClient) {
  return {
    listEmployees: () => client.request<WorkforceEmployee[]>("/workforce/employees"),
    listTasks: (filters: { status?: string; sourceEmployeeInstallationId?: string; targetEmployeeInstallationId?: string } = {}) =>
      client.request<DelegatedTask[]>(`/workforce/tasks${qs(filters)}`),
    getTask: (id: string) => client.request<DelegatedTask>(`/workforce/tasks/${id}`),
    getTaskTimeline: (id: string) => client.request<DelegatedTaskTimeline>(`/workforce/tasks/${id}/timeline`),
    cancelTask: (id: string) => client.request<DelegatedTask>(`/workforce/tasks/${id}/cancel`, { method: "POST" }),
    retryTask: (id: string) => client.request<DelegatedTask>(`/workforce/tasks/${id}/retry`, { method: "POST" }),
    delegate: (input: DelegateTaskInput) =>
      client.request<DelegatedTask>("/workforce/tasks", { method: "POST", body: JSON.stringify(input) }),
    getPolicy: () => client.request<CollaborationPolicy>("/workforce/policy"),
    updatePolicy: (input: Partial<CollaborationPolicy>) =>
      client.request<CollaborationPolicy>("/workforce/policy", { method: "PUT", body: JSON.stringify(input) })
  };
}
