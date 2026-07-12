import type { ApiClient } from "../../../lib/api-client";
import type {
  Organization,
  OrganizationResult,
  OrganizationSettings,
  OrganizationSettingsResult,
  UpdateOrganizationRequest,
  UpdateSettingsRequest
} from "../types";

export function createOrganizationApi(client: ApiClient) {
  return {
    async getOrganization(): Promise<Organization> {
      const result = await client.request<OrganizationResult>("/organizations/me", {
        method: "GET"
      });
      return result.organization;
    },

    async updateOrganization(command: UpdateOrganizationRequest): Promise<Organization> {
      const result = await client.request<OrganizationResult>("/organizations/me", {
        method: "PATCH",
        body: JSON.stringify(command)
      });
      return result.organization;
    },

    async getOrganizationSettings(): Promise<OrganizationSettings> {
      const result = await client.request<OrganizationSettingsResult>(
        "/organizations/me/settings",
        { method: "GET" }
      );
      return result.organizationSetting;
    },

    async updateOrganizationSettings(
      command: UpdateSettingsRequest
    ): Promise<OrganizationSettings> {
      const result = await client.request<OrganizationSettingsResult>(
        "/organizations/me/settings",
        { method: "PATCH", body: JSON.stringify(command) }
      );
      return result.organizationSetting;
    }
  };
}

export type OrganizationApi = ReturnType<typeof createOrganizationApi>;
