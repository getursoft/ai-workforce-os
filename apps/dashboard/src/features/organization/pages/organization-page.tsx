"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Card, PageHeader } from "../../../components/ui";
import { Can, useEffectivePermissions } from "../../admin/authorization";
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
  const permissions = useEffectivePermissions();
  const canManage = permissions.has("organization.manage");
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
      {/* Only owners/admins (organization.manage) may edit the organization — everyone else gets a
          read-only view. The backend enforces the same rule on PATCH /organizations/me(.settings). */}
      <Can permission="organization.manage">
        <OrganizationCard organization={organization.data} onSuccess={setToast} />
        <OrganizationSettingsCard settings={settings.data} onSuccess={setToast} />
      </Can>
      {!canManage ? (
        <Card className="organization-card">
          <div className="organization-card__header">
            <div>
              <p className="organization-eyebrow">Read-only</p>
              <h2>Organization</h2>
            </div>
          </div>
          <dl className="organization-readonly">
            <dt>Organization</dt>
            <dd>{organization.data.name}</dd>
            <dt>Status</dt>
            <dd>{organization.data.status}</dd>
            <dt>Timezone</dt>
            <dd>{settings.data.timezone}</dd>
            <dt>Locale</dt>
            <dd>{settings.data.locale}</dd>
            <dt>Currency</dt>
            <dd>{settings.data.currency}</dd>
          </dl>
        </Card>
      ) : null}
      {toast ? (
        <div className="organization-toast" role="status" aria-live="polite">
          ✓ {toast}
        </div>
      ) : null}
    </div>
  );
}
