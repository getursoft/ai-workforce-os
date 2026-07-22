import type { ApiClient } from "../../lib/api-client";

export const TRAVEL_EMPLOYEE_PLUGIN_ID = "travel-employee";

export interface TravelConfiguration {
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
  updatedAt?: string;
}

export interface TravelConfigurationInput {
  persona?: string;
  welcomeMessage?: string;
  businessHoursTimezone?: string;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  escalationContact?: string;
  brandTone?: string;
  defaultCurrency?: string;
  defaultLanguage?: string;
}

export type TravelStage =
  | "GREETING"
  | "COLLECT_DESTINATION"
  | "COLLECT_DATES"
  | "COLLECT_PASSENGERS"
  | "COLLECT_BUDGET"
  | "ASK_MISSING_INFO"
  | "RECOMMEND_OPTIONS"
  | "ITINERARY_SUMMARY"
  | "CONFIRM_BOOKING"
  | "BOOKING_CONFIRMED"
  | "ESCALATED";

export interface TravelConversationState {
  destination: string | null;
  travelMonth: string | null;
  durationDays: number | null;
  passengers: number | null;
  budgetAmount: number | null;
  budgetCurrency: string | null;
  stage: TravelStage;
  missingFields: string[];
}

export function createTravelApi(client: ApiClient) {
  return {
    configuration: (pluginInstallationId: string) =>
      client.request<TravelConfiguration>(`/travel-employee/${pluginInstallationId}/configuration`),
    updateConfiguration: (pluginInstallationId: string, body: TravelConfigurationInput) =>
      client.request<TravelConfiguration>(`/travel-employee/${pluginInstallationId}/configuration`, {
        method: "PATCH",
        body: JSON.stringify(body)
      }),
    state: (pluginInstallationId: string, conversationId: string) =>
      client.request<TravelConversationState>(
        `/travel-employee/${pluginInstallationId}/conversations/${conversationId}/state`
      ),
    resetConversation: (pluginInstallationId: string, conversationId: string) =>
      client.request<unknown>(
        `/travel-employee/${pluginInstallationId}/conversations/${conversationId}/reset`,
        { method: "POST" }
      )
  };
}
