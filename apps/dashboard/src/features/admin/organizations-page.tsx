"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Button } from "../../components/ui";
import { PlatformOwnerGate } from "./authorization";
import { AdminState } from "./admin-ui";

export function OrganizationsPage() {
  const router = useRouter();
  const { client, switchOrganization } = useAuth();
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["platform", "organizations"],
    queryFn: () => client.listPlatformOrganizations()
  });

  async function enterOrganization(organizationId: string, destination: "/dashboard" | "/usage") {
    setSwitchError(null);
    setSwitchingId(organizationId);
    try {
      await switchOrganization(organizationId);
      router.push(destination);
    } catch {
      setSwitchError("Could not switch into that organization. Try again.");
    } finally {
      setSwitchingId(null);
    }
  }

  return (
    <PlatformOwnerGate>
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <p className="admin-eyebrow">Administration</p>
            <h1>Organizations</h1>
            <p>
              Every organization on the platform. Only visible to the platform owner, who has full
              access to every organization.
            </p>
          </div>
        </header>
        {switchError ? (
          <Alert tone="danger" title="Unable to switch organization">
            {switchError}
          </Alert>
        ) : null}
        <AdminState query={query} empty={!query.data?.length}>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(query.data ?? []).map((organization) => (
                  <tr key={organization.id}>
                    <td>{organization.name}</td>
                    <td>{organization.slug}</td>
                    <td>
                      <Badge tone={organization.status === "ACTIVE" ? "success" : "neutral"}>
                        {organization.status}
                      </Badge>
                    </td>
                    <td>
                      <Button
                        loading={switchingId === organization.id}
                        disabled={switchingId !== null}
                        onClick={() => void enterOrganization(organization.id, "/dashboard")}
                      >
                        Open dashboard
                      </Button>
                      <Button
                        variant="secondary"
                        loading={switchingId === organization.id}
                        disabled={switchingId !== null}
                        onClick={() => void enterOrganization(organization.id, "/usage")}
                      >
                        View usage
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminState>
      </section>
    </PlatformOwnerGate>
  );
}
