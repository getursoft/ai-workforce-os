"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuth } from "../../auth/auth-provider";
import { createOrganizationApi } from "../api/organization";
import type { UpdateOrganizationRequest, UpdateSettingsRequest } from "../types";

export const organizationKeys = {
  all: ["organization"] as const,
  settings: ["organizationSettings"] as const
};

export function shouldRetryOrganizationQuery(failureCount: number): boolean {
  return failureCount < 1;
}

export function useOrganizationApi() {
  const { client } = useAuth();
  return useMemo(() => createOrganizationApi(client), [client]);
}

export function useOrganization() {
  const api = useOrganizationApi();
  return useQuery({
    queryKey: organizationKeys.all,
    queryFn: api.getOrganization,
    retry: shouldRetryOrganizationQuery
  });
}

export function useOrganizationSettings() {
  const api = useOrganizationApi();
  return useQuery({
    queryKey: organizationKeys.settings,
    queryFn: api.getOrganizationSettings,
    retry: shouldRetryOrganizationQuery
  });
}

export function useUpdateOrganization() {
  const api = useOrganizationApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: UpdateOrganizationRequest) => api.updateOrganization(command),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all });
    }
  });
}

export function useUpdateOrganizationSettings() {
  const api = useOrganizationApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (command: UpdateSettingsRequest) => api.updateOrganizationSettings(command),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: organizationKeys.settings });
    }
  });
}
