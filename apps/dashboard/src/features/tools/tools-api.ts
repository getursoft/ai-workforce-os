import type { ApiClient } from "../../lib/api-client";

export type ToolCatalogCategory =
  | "Communication"
  | "Booking"
  | "CRM"
  | "Search"
  | "Memory"
  | "Escalation"
  | "Platform";

export interface ToolCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  category: ToolCatalogCategory;
  kind: "AGENT_TOOL" | "AUTOMATIC_CAPABILITY";
}

export function createToolsApi(client: ApiClient) {
  return {
    catalog: () => client.request<ToolCatalogEntry[]>("/agents/tools")
  };
}
