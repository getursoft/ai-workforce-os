"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-provider";
import { Badge, Card, PageHeader, Skeleton } from "../../components/ui";
import { createOnboardingApi } from "./onboarding-api";

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createOnboardingApi(client), [client]);
}

export function OnboardingPage() {
  const api = useApi();
  const query = useQuery({ queryKey: ["onboarding", "checklist"], queryFn: api.checklist });

  return (
    <div className="dashboard-page">
      <PageHeader
        title="Getting started"
        description="A quick checklist to get your organization fully set up. Nothing here blocks you from using the platform — it just tracks what's left."
      />
      {query.isLoading && <Skeleton className="dashboard-page__skeleton" />}
      {query.data && (
        <Card className="dashboard-page__card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <strong>{query.data.completedCount} of {query.data.totalCount} complete</strong>
            <Badge tone={query.data.percentComplete === 100 ? "success" : "neutral"}>{query.data.percentComplete}%</Badge>
          </div>
          <div style={{ width: "100%", height: 8, background: "var(--border, #e5e7eb)", borderRadius: 4, overflow: "hidden", marginBottom: 20 }}>
            <div
              style={{
                width: `${query.data.percentComplete}%`,
                height: "100%",
                background: "var(--accent, #16a34a)",
                transition: "width 200ms ease"
              }}
            />
          </div>
          <ul className="dashboard-activity-list">
            {query.data.items.map((item) => (
              <li key={item.key} className="dashboard-activity-list__row">
                <span className="dashboard-activity-list__label">
                  {item.complete ? "✓ " : "○ "}
                  {item.label}
                </span>
                <Badge tone={item.complete ? "success" : "neutral"}>{item.complete ? "Done" : "To do"}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
