"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/auth-provider";
import { PlatformOwnerGate } from "../authorization";
import { AdminState } from "../admin-ui";
import { Alert, Badge, Button, Card, Dialog, Input, PageHeader, Skeleton, SummaryCard } from "../../../components/ui";
import {
  createPlatformLeadsApi,
  type PlatformLead,
  type PlatformLeadSource,
  type PlatformLeadStatus
} from "./platform-leads-api";

const SOURCE_LABELS: Record<PlatformLeadSource, string> = {
  WEBSITE_DEMO: "Website Demo",
  CONTACT_SALES: "Contact Sales",
  CONTACT_US: "Contact Us",
  WEBSITE_ENQUIRY: "Website Enquiry",
  OTHER: "Other"
};

const TYPE_LABELS: Record<string, string> = {
  DEMO_REQUEST: "Demo Request",
  SALES_ENQUIRY: "Sales Enquiry",
  GENERAL_ENQUIRY: "General Enquiry",
  OTHER: "Other"
};

const STATUS_OPTIONS: PlatformLeadStatus[] = ["NEW", "CONTACTED", "QUALIFIED", "DEMO_SCHEDULED", "WON", "LOST"];

const STATUS_TONES: Record<PlatformLeadStatus, "neutral" | "success" | "warning" | "danger"> = {
  NEW: "warning",
  CONTACTED: "neutral",
  QUALIFIED: "neutral",
  DEMO_SCHEDULED: "neutral",
  WON: "success",
  LOST: "danger"
};

type DateRange = "ALL" | "TODAY" | "7D" | "30D";

function rangeToFromTo(range: DateRange): { from?: string; to?: string } {
  if (range === "ALL") return {};
  const now = new Date();
  const from = new Date(now);
  if (range === "TODAY") from.setHours(0, 0, 0, 0);
  if (range === "7D") from.setDate(from.getDate() - 7);
  if (range === "30D") from.setDate(from.getDate() - 30);
  return { from: from.toISOString() };
}

function truncate(value: string | null, max = 60): string {
  if (!value) return "—";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function StatusBadge({ status }: Readonly<{ status: PlatformLeadStatus }>) {
  return <Badge tone={STATUS_TONES[status]}>{status.replace(/_/g, " ")}</Badge>;
}

function LeadDetail({
  lead,
  onStatusChange,
  statusPending
}: Readonly<{
  lead: PlatformLead;
  onStatusChange: (status: PlatformLeadStatus) => void;
  statusPending: boolean;
}>) {
  return (
    <div className="sales-lead-detail">
      <div className="admin-details">
        <dt>Email</dt>
        <dd>{lead.email}</dd>
        <dt>Phone</dt>
        <dd>{lead.phone ?? "—"}</dd>
        <dt>Company</dt>
        <dd>{lead.company ?? "—"}</dd>
        <dt>Source</dt>
        <dd>{SOURCE_LABELS[lead.source]}</dd>
        <dt>Lead Type</dt>
        <dd>{TYPE_LABELS[lead.type] ?? lead.type}</dd>
        {lead.preferredDemoDate ? (
          <>
            <dt>Preferred Demo</dt>
            <dd>
              {lead.preferredDemoDate}
              {lead.preferredDemoTime ? ` at ${lead.preferredDemoTime}` : ""}
              {lead.timezone ? ` (${lead.timezone})` : ""}
            </dd>
          </>
        ) : null}
        <dt>Status</dt>
        <dd>
          <StatusBadge status={lead.status} />
        </dd>
        <dt>Created</dt>
        <dd>{formatDate(lead.createdAt)}</dd>
        <dt>Updated</dt>
        <dd>{formatDate(lead.updatedAt)}</dd>
      </div>
      {lead.requirement ? (
        <div style={{ marginTop: 16 }}>
          <Label_>Requirement / Message</Label_>
          <p style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{lead.requirement}</p>
        </div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <Label_>Update status</Label_>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          {STATUS_OPTIONS.map((option) => (
            <Button
              key={option}
              variant={option === lead.status ? "primary" : "secondary"}
              disabled={statusPending || option === lead.status}
              loading={statusPending && option !== lead.status}
              onClick={() => onStatusChange(option)}
            >
              {option.replace(/_/g, " ")}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Label_({ children }: Readonly<{ children: ReactNode }>) {
  return <p style={{ fontSize: "0.82rem", color: "var(--muted)", fontWeight: 600 }}>{children}</p>;
}

export function SalesLeadsPage() {
  const { client } = useAuth();
  const qc = useQueryClient();
  const api = useMemo(() => createPlatformLeadsApi(client), [client]);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<PlatformLeadSource | "ALL">("ALL");
  const [status, setStatus] = useState<PlatformLeadStatus | "ALL">("ALL");
  const [range, setRange] = useState<DateRange>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(id);
  }, [searchInput]);

  const listParams = useMemo(
    () => ({ ...(search ? { search } : {}), source, status, ...rangeToFromTo(range) }),
    [search, source, status, range]
  );

  const summaryQuery = useQuery({
    queryKey: ["platform-sales-leads", "summary"],
    queryFn: () => api.summary()
  });

  const listQuery = useQuery({
    queryKey: ["platform-sales-leads", "list", listParams],
    queryFn: () => api.list(listParams)
  });

  const detailQuery = useQuery({
    queryKey: ["platform-sales-leads", "detail", selectedId],
    queryFn: () => (selectedId ? api.get(selectedId) : Promise.resolve(null)),
    enabled: Boolean(selectedId)
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status: next }: { id: string; status: PlatformLeadStatus }) => api.updateStatus(id, next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform-sales-leads"] });
    }
  });

  const items = listQuery.data?.items ?? [];

  return (
    <PlatformOwnerGate>
      <section className="admin-page">
        <PageHeader
          title="Sales Leads"
          eyebrow="Platform"
          description="Leads generated for Krevia itself — website demo requests, contact-us enquiries, and sales enquiries. Tenant organizations' own customer leads never appear here."
        />

        <div className="admin-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          <SummaryCard title="Total Leads" value={summaryQuery.data?.total ?? "—"} />
          <SummaryCard title="New" value={summaryQuery.data?.new ?? "—"} />
          <SummaryCard title="Demo Requests" value={summaryQuery.data?.demoRequests ?? "—"} />
          <SummaryCard title="Contacted" value={summaryQuery.data?.contacted ?? "—"} />
          <SummaryCard title="Qualified" value={summaryQuery.data?.qualified ?? "—"} />
          <SummaryCard title="Won" value={summaryQuery.data?.won ?? "—"} />
        </div>

        <Card className="admin-toolbar" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <Input
            placeholder="Search name, email, company, phone…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            style={{ minWidth: 240 }}
            aria-label="Search leads"
          />
          <select
            className="ui-input"
            value={source}
            onChange={(event) => setSource(event.target.value as PlatformLeadSource | "ALL")}
            aria-label="Filter by source"
          >
            <option value="ALL">All sources</option>
            {(Object.keys(SOURCE_LABELS) as PlatformLeadSource[]).map((value) => (
              <option key={value} value={value}>
                {SOURCE_LABELS[value]}
              </option>
            ))}
          </select>
          <select
            className="ui-input"
            value={status}
            onChange={(event) => setStatus(event.target.value as PlatformLeadStatus | "ALL")}
            aria-label="Filter by status"
          >
            <option value="ALL">All statuses</option>
            {STATUS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select
            className="ui-input"
            value={range}
            onChange={(event) => setRange(event.target.value as DateRange)}
            aria-label="Filter by date"
          >
            <option value="ALL">All time</option>
            <option value="TODAY">Today</option>
            <option value="7D">Last 7 days</option>
            <option value="30D">Last 30 days</option>
          </select>
        </Card>

        <AdminState query={listQuery} empty={!items.length}>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Lead Type</th>
                  <th>Source</th>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => setSelectedId(lead.id)}
                    style={{ cursor: "pointer" }}
                    className={selectedId === lead.id ? "admin-table__row--active" : ""}
                  >
                    <td>
                      <strong>{lead.name}</strong>
                    </td>
                    <td>{lead.company ?? "—"}</td>
                    <td>
                      {lead.email}
                      {lead.phone ? <div style={{ color: "var(--muted)" }}>{lead.phone}</div> : null}
                    </td>
                    <td>{TYPE_LABELS[lead.type] ?? lead.type}</td>
                    <td>{SOURCE_LABELS[lead.source]}</td>
                    <td>{truncate(lead.requirement)}</td>
                    <td>
                      <StatusBadge status={lead.status} />
                    </td>
                    <td>{new Date(lead.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminState>

        <Dialog
          open={Boolean(selectedId)}
          title={detailQuery.data?.name ?? "Lead details"}
          showActions={false}
          onCancel={() => setSelectedId(null)}
          onConfirm={() => {}}
        >
          {detailQuery.isLoading ? (
            <Skeleton />
          ) : detailQuery.error ? (
            <Alert tone="danger" title="Unable to load lead" />
          ) : detailQuery.data ? (
            <LeadDetail
              lead={detailQuery.data}
              statusPending={statusMutation.isPending}
              onStatusChange={(next) => statusMutation.mutate({ id: detailQuery.data!.id, status: next })}
            />
          ) : null}
          <div className="ui-dialog__actions">
            <Button type="button" variant="secondary" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          </div>
        </Dialog>
      </section>
    </PlatformOwnerGate>
  );
}
