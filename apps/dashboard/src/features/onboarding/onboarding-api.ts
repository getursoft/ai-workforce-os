import type { ApiClient } from "../../lib/api-client";

export interface OnboardingChecklistItem {
  key: string;
  label: string;
  complete: boolean;
}

export interface OnboardingChecklist {
  items: OnboardingChecklistItem[];
  completedCount: number;
  totalCount: number;
  percentComplete: number;
}

export function createOnboardingApi(client: ApiClient) {
  return {
    checklist: () => client.request<OnboardingChecklist>("/onboarding/checklist")
  };
}
