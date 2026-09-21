"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AccessGate } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, BackLink, Button, Card, EmptyState, Label, Skeleton } from "../../components/ui";
import { createInteractionApi, type InteractionChannel, type InteractionStatus } from "./interaction-api";

const key = ["interactions"] as const;

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createInteractionApi(client), [client]);
}

const STATUSES: InteractionStatus[] = ["OPEN", "ACTIVE", "WAITING", "COMPLETED", "FAILED", "CANCELLED"];
const CHANNELS: InteractionChannel[] = ["WEB_CHAT", "WHATSAPP", "VOICE"];

export function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "CANCELLED") return "danger";
  if (status === "ACTIVE" || status === "WAITING") return "warning";
  return "neutral";
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

export function InteractionsPage() {
  const api = useApi();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<InteractionStatus | "">("");
  const [channel, setChannel] = useState<InteractionChannel | "">("");
  const interactions = useQuery({
    queryKey: [...key, "list", page, status, channel],
    queryFn: () => api.list({ page, pageSize: 20, ...(status ? { status } : {}), ...(channel ? { channel } : {}) })
  });
  return (
    <AccessGate permission="agents.conversations.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Interactions</h1>
            <p>Every customer case/reference across web chat, WhatsApp, and voice.</p>
          </div>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="interaction-status">Status</Label>
          <select
            id="interaction-status"
            className="ui-input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as InteractionStatus | "");
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Label htmlFor="interaction-channel">Channel</Label>
          <select
            id="interaction-channel"
            className="ui-input"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as InteractionChannel | "");
              setPage(1);
            }}
          >
            <option value="">All channels</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </Card>
        {interactions.isLoading ? (
          <Skeleton />
        ) : interactions.isError ? (
          <Alert tone="danger" title="Unable to load interactions">
            <Button onClick={() => interactions.refetch()}>Retry</Button>
          </Alert>
        ) : interactions.data?.items.length ? (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Started</th>
                    <th>Channel</th>
                    <th>Contact</th>
                    <th>Status</th>
                    <th>Notifications</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {interactions.data.items.map((item) => (
                    <tr key={item.id}>
                      <td><strong>{item.referenceId}</strong></td>
                      <td>{new Date(item.startedAt).toLocaleString()}</td>
                      <td>{item.channel}{item.transport ? ` (${item.transport})` : ""}</td>
                      <td>{item.phoneNumber ?? item.email ?? "—"}</td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>{item.referenceCommunicatedAt ? "Sent" : "—"}</td>
                      <td><Link href={`/interactions/${item.id}`}>View</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-pagination">
              <Button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>Previous</Button>
              <span>Page {page} of {Math.max(1, interactions.data.totalPages)}</span>
              <Button disabled={page >= interactions.data.totalPages} onClick={() => setPage((x) => x + 1)}>Next</Button>
            </div>
          </>
        ) : (
          <EmptyState title="No interactions yet" description="A case/reference is created as soon as a customer's first message or call comes in." />
        )}
      </section>
    </AccessGate>
  );
}

export function InteractionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const interaction = useQuery({ queryKey: [...key, id], queryFn: () => api.get(id) });
  const notifications = useQuery({ queryKey: [...key, id, "notifications"], queryFn: () => api.notifications(id) });

  if (interaction.isLoading) return <Skeleton />;
  if (!interaction.data) return <EmptyState title="Interaction not found" description="It may not exist or you may not have access." />;
  const item = interaction.data;

  return (
    <AccessGate permission="agents.conversations.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <BackLink href="/interactions" label="Back to Interactions" />
            <h1>Reference {item.referenceId}</h1>
            <p>{item.channel}{item.transport ? ` · ${item.transport}` : ""} · {new Date(item.startedAt).toLocaleString()}</p>
          </div>
          <StatusBadge status={item.status} />
        </header>

        <Card>
          <h2>Summary</h2>
          <div className="admin-grid">
            <div><Label>Contact</Label><p>{item.phoneNumber ?? item.email ?? "—"}</p></div>
            <div><Label>Started</Label><p>{new Date(item.startedAt).toLocaleString()}</p></div>
            <div><Label>Completed</Label><p>{item.completedAt ? new Date(item.completedAt).toLocaleString() : "—"}</p></div>
            <div><Label>Reference communicated</Label><p>{item.referenceCommunicatedAt ? "Yes" : "Not yet"}</p></div>
            {item.conversationId ? <div><Label>Conversation</Label><p>{item.conversationId}</p></div> : null}
            {item.voiceSessionId ? (
              <div><Label>Voice call</Label><p><Link href={`/voice-calls/${item.voiceSessionId}`}>View call</Link></p></div>
            ) : null}
          </div>
          {item.resolutionSummary ? (
            <div><Label>Resolution</Label><p>{item.resolutionSummary}</p></div>
          ) : null}
        </Card>

        <Card>
          <h2>Notifications</h2>
          {notifications.isLoading ? (
            <Skeleton />
          ) : notifications.data?.length ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>Type</th><th>Destination</th><th>Status</th><th>Requested</th><th>Failure</th></tr></thead>
                <tbody>
                  {notifications.data.map((n) => (
                    <tr key={n.id}>
                      <td>{n.type}</td>
                      <td>{n.destinationMasked || "—"}</td>
                      <td><Badge tone={n.status === "SENT" || n.status === "DELIVERED" ? "success" : n.status === "FAILED" ? "danger" : "neutral"}>{n.status}</Badge></td>
                      <td>{new Date(n.requestedAt).toLocaleString()}</td>
                      <td>{n.failureReason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No notifications recorded for this interaction.</p>
          )}
        </Card>
      </section>
    </AccessGate>
  );
}
