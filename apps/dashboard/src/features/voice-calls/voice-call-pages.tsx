"use client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AccessGate } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, BackLink, Button, Card, EmptyState, Label, Skeleton } from "../../components/ui";
import { createVoiceCallApi, type VoiceSessionStatus, type VoiceTransport } from "./voice-call-api";

const key = ["voice-calls"] as const;

function useApi() {
  const { client } = useAuth();
  return useMemo(() => createVoiceCallApi(client), [client]);
}

const STATUSES: VoiceSessionStatus[] = ["CREATED", "RINGING", "CONNECTING", "ACTIVE", "INTERRUPTED", "ENDING", "ENDED", "FAILED"];
const TRANSPORTS: VoiceTransport[] = ["WHATSAPP", "PSTN", "WEBRTC", "SIMULATOR"];

export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "ENDED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "ACTIVE" || status === "INTERRUPTED") return "warning";
  return "neutral";
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status}</Badge>;
}

export function VoiceCallsPage() {
  const api = useApi();
  const searchParams = useSearchParams();
  const channelConnectionId = searchParams.get("channelConnectionId") ?? undefined;
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<VoiceSessionStatus | "">("");
  const [transport, setTransport] = useState<VoiceTransport | "">("");
  const calls = useQuery({
    queryKey: [...key, "list", page, status, transport, channelConnectionId],
    queryFn: () =>
      api.list({
        page,
        pageSize: 20,
        ...(status ? { status } : {}),
        ...(transport ? { transport } : {}),
        ...(channelConnectionId ? { channelConnectionId } : {})
      })
  });
  return (
    <AccessGate permission="channel.message.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Voice Calls</h1>
            <p>Call history for AI Employee voice conversations.</p>
          </div>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="voice-status">Status</Label>
          <select
            id="voice-status"
            className="ui-input"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as VoiceSessionStatus | "");
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <Label htmlFor="voice-transport">Transport</Label>
          <select
            id="voice-transport"
            className="ui-input"
            value={transport}
            onChange={(e) => {
              setTransport(e.target.value as VoiceTransport | "");
              setPage(1);
            }}
          >
            <option value="">All transports</option>
            {TRANSPORTS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </Card>
        {calls.isLoading ? (
          <Skeleton />
        ) : calls.isError ? (
          <Alert tone="danger" title="Unable to load voice calls">
            <Button onClick={() => calls.refetch()}>Retry</Button>
          </Alert>
        ) : calls.data?.items.length ? (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Caller</th>
                    <th>Status</th>
                    <th>Transport</th>
                    <th>Provider</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.data.items.map((call) => (
                    <tr key={call.id}>
                      <td>{new Date(call.startedAt).toLocaleString()}</td>
                      <td>{formatDuration(call.durationSeconds)}</td>
                      <td>{call.callerId ?? "—"}</td>
                      <td><StatusBadge status={call.status} /></td>
                      <td>{call.transport}</td>
                      <td>{call.provider}</td>
                      <td><Link href={`/voice-calls/${call.id}`}>View</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="admin-pagination">
              <Button disabled={page <= 1} onClick={() => setPage((x) => x - 1)}>Previous</Button>
              <span>Page {page} of {Math.max(1, calls.data.totalPages)}</span>
              <Button disabled={page >= calls.data.totalPages} onClick={() => setPage((x) => x + 1)}>Next</Button>
            </div>
          </>
        ) : (
          <EmptyState title="No voice calls yet" description="Calls will appear here once a voice-enabled channel receives one." />
        )}
      </section>
    </AccessGate>
  );
}

export function VoiceCallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const call = useQuery({ queryKey: [...key, id], queryFn: () => api.get(id) });
  const transcript = useQuery({ queryKey: [...key, id, "transcript"], queryFn: () => api.transcript(id) });

  if (call.isLoading) return <Skeleton />;
  if (!call.data) return <EmptyState title="Voice call not found" description="It may not exist or you may not have access." />;
  const item = call.data;

  return (
    <AccessGate permission="channel.message.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <BackLink href="/voice-calls" label="Back to Voice Calls" />
            <h1>Call {item.providerCallId}</h1>
            <p>{item.callerId ?? "Unknown caller"} · {new Date(item.startedAt).toLocaleString()}</p>
          </div>
          <StatusBadge status={item.status} />
        </header>

        <Card>
          <h2>Summary</h2>
          <div className="admin-grid">
            <div><Label>Duration</Label><p>{formatDuration(item.durationSeconds)}</p></div>
            <div><Label>Transport</Label><p>{item.transport}</p></div>
            <div><Label>Provider</Label><p>{item.provider}</p></div>
            <div><Label>Termination reason</Label><p>{item.terminationReason ?? "—"}</p></div>
            <div><Label>Routing time</Label><p>{item.routingMs !== null ? `${item.routingMs} ms` : "—"}</p></div>
            <div><Label>Specialist first response</Label><p>{item.specialistFirstResponseMs !== null ? `${item.specialistFirstResponseMs} ms` : "—"}</p></div>
          </div>
        </Card>

        {item.handoffs.length > 0 ? (
          <Card>
            <h2>Agent Handoffs</h2>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead><tr><th>Started</th><th>Status</th><th>Intent</th><th>Capability</th></tr></thead>
                <tbody>
                  {item.handoffs.map((h) => (
                    <tr key={h.id}>
                      <td>{new Date(h.startedAt).toLocaleString()}</td>
                      <td><Badge>{h.status}</Badge></td>
                      <td>{h.routingIntent ?? "—"}</td>
                      <td>{h.routingCapability ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        <Card>
          <h2>Transcript</h2>
          {transcript.isLoading ? (
            <Skeleton />
          ) : transcript.data?.items.length ? (
            <ol className="voice-transcript">
              {transcript.data.items.map((seg) => (
                <li key={seg.id} className={`voice-transcript__segment voice-transcript__segment--${seg.speaker.toLowerCase()}`}>
                  <strong>{seg.speaker}</strong>
                  <span>{seg.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No transcript recorded for this call.</p>
          )}
        </Card>
      </section>
    </AccessGate>
  );
}
