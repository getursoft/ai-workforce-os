"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AccessGate } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Skeleton } from "../../components/ui";
import { createToolsApi, type ToolCatalogEntry } from "./tools-api";

function useToolsApi() {
  const { client } = useAuth();
  return useMemo(() => createToolsApi(client), [client]);
}

const CATEGORY_ORDER: readonly ToolCatalogEntry["category"][] = [
  "Communication",
  "Booking",
  "CRM",
  "Search",
  "Memory",
  "Escalation",
  "Platform"
];

export function ToolsPage() {
  const api = useToolsApi();
  const q = useQuery({ queryKey: ["tools", "catalog"], queryFn: api.catalog });

  const grouped = useMemo(() => {
    const byCategory = new Map<ToolCatalogEntry["category"], ToolCatalogEntry[]>();
    for (const entry of q.data ?? []) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }
    return CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
      category,
      entries: byCategory.get(category) ?? []
    }));
  }, [q.data]);

  return (
    <AccessGate permission="agents.run">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Tools</h1>
            <p>
              Reusable tools and capabilities available to your AI employees — some are directly callable
              during a conversation, others run automatically as part of a workflow (e.g. sending a
              ticket).
            </p>
          </div>
        </header>
        {q.isLoading ? <Skeleton /> : null}
        {q.isError ? (
          <Alert tone="danger" title="Unable to load the tool catalog">
            Try refreshing the page.
          </Alert>
        ) : null}
        {grouped.map(({ category, entries }) => (
          <div key={category}>
            <div className="admin-section-header">
              <div>
                <h2>{category}</h2>
              </div>
            </div>
            <div className="admin-grid">
              {entries.map((entry) => (
                <div key={entry.name} className="admin-grid-card">
                  <div>
                    <h3>{entry.displayName}</h3>
                    <p>{entry.description}</p>
                  </div>
                  <Badge tone={entry.kind === "AGENT_TOOL" ? "success" : "neutral"}>
                    {entry.kind === "AGENT_TOOL" ? "Agent tool" : "Automatic capability"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </AccessGate>
  );
}
