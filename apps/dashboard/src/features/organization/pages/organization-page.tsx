"use client";

import { useEffect, useState } from "react";
import { Alert, Button, PageHeader } from "../../../components/ui";
import { useOrganization, useOrganizationSettings } from "../hooks/use-organization";
import { OrganizationCard } from "../components/organization-card";
import { OrganizationSettingsCard } from "../components/organization-settings-card";
import {
  friendlyOrganizationError,
  LoadingSkeleton,
  OrganizationEmptyState
} from "../components/organization-ui";

export function OrganizationPage() {
  const organization = useOrganization();
  const settings = useOrganizationSettings();
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timeout = globalThis.setTimeout(() => setToast(null), 4_000);
    return () => globalThis.clearTimeout(timeout);
  }, [toast]);

  if (organization.isLoading || settings.isLoading) return <LoadingSkeleton />;
  if (organization.error || settings.error) {
    const error = organization.error ?? settings.error;
    return (
      <div className="organization-page">
        <Alert tone="danger" title="Could not load organization">
          <p>{friendlyOrganizationError(error)}</p>
        </Alert>
        <Button
          type="button"
          onClick={() => {
            void organization.refetch();
            void settings.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!organization.data || !settings.data)
    return (
      <OrganizationEmptyState
        onRetry={() => {
          void organization.refetch();
          void settings.refetch();
        }}
      />
    );

  return (
    <div className="organization-page">
      <PageHeader
        eyebrow="Administration"
        title="Organization"
        description="Manage your organization identity and regional preferences."
      />
      <OrganizationCard organization={organization.data} onSuccess={setToast} />
      <OrganizationSettingsCard settings={settings.data} onSuccess={setToast} />
      {toast ? (
        <div className="organization-toast" role="status" aria-live="polite">
          ✓ {toast}
        </div>
      ) : null}
    </div>
  );
}
