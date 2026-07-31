import type { ApiClient } from "../../lib/api-client";

export interface EmployeeConfiguration {
  pluginInstallationId: string;
  configured: boolean;
  persona: string;
  welcomeMessage: string;
  businessHoursTimezone: string | null;
  businessHoursStart: string | null;
  businessHoursEnd: string | null;
  escalationContact: string;
  brandTone: string;
  defaultCurrency: string;
  defaultLanguage: string;
  apiEnabled?: boolean;
  apiEndpoint?: string | null;
  apiKey?: string | null;
  defaultCountry?: string;
  updatedAt?: string;
}

export interface EmployeeConfigurationInput {
  persona?: string;
  welcomeMessage?: string;
  businessHoursTimezone?: string;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  escalationContact?: string;
  brandTone?: string;
  defaultCurrency?: string;
  defaultLanguage?: string;
  apiEnabled?: boolean;
  apiEndpoint?: string;
  apiKey?: string;
  defaultCountry?: string;
}

export interface EmployeeConversationState {
  customerName: string | null;
  stage: string;
  onboardingCompleted: boolean;
  greetingSent: boolean;
  missingFields: string[];
  completionStage?: string;
  capturedReference?: string | null;
}

/** Shared API client for every non-Travel domain employee (HR, Finance, IT, Sales, Marketing, Legal,
 *  Customer Support) — same layout/orientation as `createTravelApi`, just parameterized by the route
 *  prefix and artifact endpoint so the config form + state + artifact list behave identically. */
export function createEmployeeApi(client: ApiClient, basePath: string, artifactEndpoint: string) {
  return {
    configuration: (pluginInstallationId: string) =>
      client.request<EmployeeConfiguration>(`${basePath}/${pluginInstallationId}/configuration`),
    updateConfiguration: (pluginInstallationId: string, body: EmployeeConfigurationInput) =>
      client.request<EmployeeConfiguration>(`${basePath}/${pluginInstallationId}/configuration`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    state: (pluginInstallationId: string, conversationId: string) =>
      client.request<EmployeeConversationState>(
        `${basePath}/${pluginInstallationId}/conversations/${conversationId}/state`
      ),
    resetConversation: (pluginInstallationId: string, conversationId: string) =>
      client.request<unknown>(
        `${basePath}/${pluginInstallationId}/conversations/${conversationId}/reset`,
        { method: "POST" }
      ),
    artifacts: (pluginInstallationId: string) =>
      client.request<unknown[]>(`${basePath}/${pluginInstallationId}/${artifactEndpoint}`)
  };
}
