"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { createAgentApi } from "../agents/agent-api";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Skeleton
} from "../../components/ui";
import { createChannelApi, type ChannelConfigurationInput } from "./channel-api";

const key = ["channels"] as const;
function useApi() {
  const { client } = useAuth();
  return useMemo(() => createChannelApi(client), [client]);
}
function useAgents() {
  const { client } = useAuth();
  const api = useMemo(() => createAgentApi(client), [client]);
  return useQuery({ queryKey: ["channels", "agents"], queryFn: api.employees });
}
export function statusMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "UNKNOWN_ERROR";
  const messages: Record<string, string> = {
    CHANNEL_CONFIGURATION_INCOMPLETE: "Account SID, Auth Token, and sender number are all required.",
    AGENT_NOT_FOUND: "Select an active AI employee to bind this channel to.",
    AGENT_NOT_ACTIVE: "The selected AI employee is not active.",
    CHANNEL_CREDENTIALS_REQUIRED: "Configure the Twilio credentials before testing or enabling.",
    CHANNEL_PROVIDER_AUTHENTICATION_FAILED: "Twilio rejected the configured Account SID or Auth Token.",
    CHANNEL_PROVIDER_RATE_LIMITED: "Twilio rate-limited the request. Try again shortly.",
    CHANNEL_PROVIDER_UNAVAILABLE: "Twilio is currently unavailable.",
    CHANNEL_PROVIDER_TIMEOUT: "The request to Twilio timed out.",
    CHANNEL_NOT_FOUND: "This channel is no longer available."
  };
  return messages[code] ?? "Check the fields and try again.";
}

export function ChannelsPage() {
  const api = useApi();
  const [search, setSearch] = useState("");
  const channels = useQuery({
    queryKey: [...key, "list", search],
    queryFn: () => api.list({ pageSize: 50, search })
  });
  return (
    <AccessGate permission="channel.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Channels</h1>
            <p>Connect WhatsApp and other messaging channels to your AI employees.</p>
          </div>
          <Can permission="channel.create">
            <Link href="/channels/new">
              <Button>New channel</Button>
            </Link>
          </Can>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="channel-search">Search channels</Label>
          <Input
            id="channel-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Card>
        {channels.isLoading ? (
          <Skeleton />
        ) : channels.isError ? (
          <Alert tone="danger" title="Unable to load channels">
            <Button onClick={() => channels.refetch()}>Retry</Button>
          </Alert>
        ) : channels.data?.items.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Bound agent</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {channels.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>
                      {item.provider} · {item.channelType}
                    </td>
                    <td>
                      <Badge tone={item.status === "ACTIVE" ? "success" : "neutral"}>
                        {item.status}
                      </Badge>
                    </td>
                    <td>{item.agent.displayName}</td>
                    <td>
                      <Link href={`/channels/${item.id}`}>Manage</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No channels configured"
            description="Create a WhatsApp channel to let customers message an AI employee directly."
          />
        )}
      </section>
    </AccessGate>
  );
}

export function NewChannelPage() {
  const api = useApi(),
    router = useRouter();
  const agents = useAgents();
  const create = useMutation({
    mutationFn: (body: {
      name: string;
      provider: "TWILIO";
      channelType: "WHATSAPP";
      agentId: string;
      configuration: ChannelConfigurationInput;
    }) => api.create(body),
    onSuccess: (channel) => router.push(`/channels/${channel.id}`)
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      name: String(data.get("name") ?? "").trim(),
      provider: "TWILIO",
      channelType: "WHATSAPP",
      agentId: String(data.get("agentId") ?? ""),
      configuration: {
        accountSid: String(data.get("accountSid") ?? "").trim(),
        authToken: String(data.get("authToken") ?? "").trim(),
        fromNumber: String(data.get("fromNumber") ?? "").trim()
      }
    });
  };
  return (
    <AccessGate permission="channel.create">
      <section className="admin-page">
        <Link href="/channels">← Channels</Link>
        <header className="admin-page__header">
          <div>
            <h1>New WhatsApp channel</h1>
            <p>Configure a Twilio WhatsApp sender and bind it to an AI employee.</p>
          </div>
        </header>
        <Card>
          <form className="admin-form" onSubmit={submit}>
            <Label htmlFor="channel-name">Name</Label>
            <Input id="channel-name" name="name" required maxLength={160} placeholder="Travel WhatsApp" />

            <Label htmlFor="channel-agent">Bound AI employee</Label>
            <select id="channel-agent" name="agentId" required disabled={agents.isLoading}>
              <option value="">Select an AI employee…</option>
              {agents.data?.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </select>

            <Label htmlFor="channel-account-sid">Twilio Account SID</Label>
            <Input id="channel-account-sid" name="accountSid" required placeholder="AC…" />

            <Label htmlFor="channel-auth-token">Twilio Auth Token</Label>
            <Input
              id="channel-auth-token"
              name="authToken"
              type="password"
              autoComplete="new-password"
              required
            />

            <Label htmlFor="channel-from-number">WhatsApp sender number</Label>
            <Input
              id="channel-from-number"
              name="fromNumber"
              required
              placeholder="+14155238886"
            />

            {create.isError ? (
              <Alert tone="danger" title="Channel was not created">
                {statusMessage(create.error)}
              </Alert>
            ) : null}
            <Button type="submit" loading={create.isPending} disabled={create.isPending}>
              Create channel
            </Button>
          </form>
        </Card>
      </section>
    </AccessGate>
  );
}

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>(),
    api = useApi(),
    qc = useQueryClient(),
    router = useRouter();
  const agents = useAgents();
  const channel = useQuery({ queryKey: [...key, id], queryFn: () => api.get(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const update = useMutation({
    mutationFn: (body: {
      name?: string;
      agentId?: string;
      configuration?: ChannelConfigurationInput;
    }) => api.update(id, body),
    onSuccess: refresh
  });
  const toggle = useMutation({
    mutationFn: (name: "enable" | "disable") => api[name](id),
    onSuccess: refresh
  });
  const test = useMutation({
    mutationFn: () => api.test(id),
    onSuccess: refresh
  });
  const remove = useMutation({
    mutationFn: () => api.remove(id),
    onSuccess: () => router.push("/channels")
  });
  const [copied, setCopied] = useState(false);
  if (channel.isLoading) return <Skeleton />;
  if (!channel.data)
    return <EmptyState title="Channel not found" description="It may have been archived." />;
  const item = channel.data;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const accountSid = String(data.get("accountSid") ?? "").trim();
    const authToken = String(data.get("authToken") ?? "").trim();
    const fromNumber = String(data.get("fromNumber") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();
    const agentId = String(data.get("agentId") ?? "");
    update.mutate({
      ...(name ? { name } : {}),
      ...(agentId ? { agentId } : {}),
      configuration: { accountSid, authToken, fromNumber }
    });
  };
  return (
    <AccessGate permission="channel.read">
      <section className="admin-page">
        <Link href="/channels">← Channels</Link>
        <header className="admin-page__header">
          <div>
            <h1>{item.name}</h1>
            <p>
              {item.provider} · {item.channelType} · bound to {item.agent.displayName}
            </p>
          </div>
          <Badge tone={item.status === "ACTIVE" ? "success" : "neutral"}>{item.status}</Badge>
        </header>
        <Card className="admin-toolbar">
          <Can permission="channel.test">
            <Button loading={test.isPending} onClick={() => test.mutate()}>
              Test connection
            </Button>
          </Can>
          <Can permission="channel.update">
            {item.status === "ACTIVE" ? (
              <Button
                variant="secondary"
                loading={toggle.isPending}
                onClick={() => toggle.mutate("disable")}
              >
                Disable
              </Button>
            ) : (
              <Button loading={toggle.isPending} onClick={() => toggle.mutate("enable")}>
                Enable
              </Button>
            )}
          </Can>
          <span>
            Last tested:{" "}
            {item.lastTestedAt ? new Date(item.lastTestedAt).toLocaleString() : "Never"}{" "}
            {item.lastTestStatus ? <Badge>{item.lastTestStatus}</Badge> : null}
          </span>
        </Card>
        {toggle.isError ? (
          <Alert tone="danger" title="Channel action failed">
            {statusMessage(toggle.error)}
          </Alert>
        ) : null}
        {test.isError ? (
          <Alert tone="danger" title="Channel connection test failed">
            {statusMessage(test.error)}
          </Alert>
        ) : null}

        <Card>
          <h2>Webhook URL</h2>
          <p>Paste this URL into the Twilio WhatsApp sender&apos;s incoming message webhook.</p>
          <Input readOnly value={item.webhookUrl} aria-label="Webhook URL" />
          <Button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(item.webhookUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </Card>

        <Can permission="channel.update">
          <Card>
            <h2>Configuration</h2>
            <form className="admin-form" onSubmit={submit}>
              <Label htmlFor="channel-edit-name">Name</Label>
              <Input id="channel-edit-name" name="name" defaultValue={item.name} maxLength={160} />

              <Label htmlFor="channel-edit-agent">Bound AI employee</Label>
              <select id="channel-edit-agent" name="agentId" defaultValue={item.agentId}>
                {agents.data?.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.displayName}
                  </option>
                ))}
              </select>

              <Label htmlFor="channel-edit-account-sid">Twilio Account SID</Label>
              <Input
                id="channel-edit-account-sid"
                name="accountSid"
                defaultValue={item.configuration.accountSid ?? ""}
              />

              <Label htmlFor="channel-edit-auth-token">Twilio Auth Token</Label>
              <Input
                id="channel-edit-auth-token"
                name="authToken"
                type="password"
                autoComplete="new-password"
              />
              <small>
                {item.hasAuthToken
                  ? "Configured. Leave blank to keep the stored Auth Token."
                  : "Not configured."}
              </small>

              <Label htmlFor="channel-edit-from-number">WhatsApp sender number</Label>
              <Input
                id="channel-edit-from-number"
                name="fromNumber"
                defaultValue={item.configuration.fromNumber ?? ""}
              />

              {update.isError ? (
                <Alert tone="danger" title="Channel was not updated">
                  {statusMessage(update.error)}
                </Alert>
              ) : null}
              <Button type="submit" loading={update.isPending} disabled={update.isPending}>
                Save changes
              </Button>
            </form>
          </Card>
        </Can>

        <Link href={`/channels/${item.id}/conversations`}>View conversations →</Link>

        <Can permission="channel.delete">
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Archive channel
          </Button>
        </Can>
      </section>
    </AccessGate>
  );
}

export function ChannelConversationsPage() {
  const { id } = useParams<{ id: string }>(),
    api = useApi();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const channel = useQuery({ queryKey: [...key, id], queryFn: () => api.get(id) });
  const conversations = useQuery({
    queryKey: [...key, id, "conversations"],
    queryFn: () => api.conversations(id)
  });
  const messages = useQuery({
    queryKey: [...key, id, "messages", selected],
    queryFn: () => api.messages(id, selected),
    enabled: Boolean(selected)
  });
  return (
    <AccessGate permission="channel.message.read">
      <section className="admin-page">
        <Link href={`/channels/${id}`}>← {channel.data?.name ?? "Channel"}</Link>
        <header className="admin-page__header">
          <div>
            <h1>Conversations</h1>
            <p>Inbound and outbound WhatsApp messages for this channel.</p>
          </div>
        </header>
        <div className="admin-grid">
          <Card>
            <h2>Conversations</h2>
            {conversations.isLoading ? (
              <Skeleton />
            ) : conversations.data?.items.length ? (
              conversations.data.items.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className="admin-nav__item"
                  onClick={() => setSelected(conversation.id)}
                >
                  <strong>{conversation.externalUserId ?? conversation.title}</strong>
                  <Badge tone={conversation.status === "ACTIVE" ? "success" : "neutral"}>
                    {conversation.status}
                  </Badge>
                  <small>{conversation._count.messages} messages</small>
                </button>
              ))
            ) : (
              <EmptyState
                title="No conversations yet"
                description="Send a WhatsApp message to the configured sender number to start one."
              />
            )}
          </Card>
          <Card>
            <h2>Messages</h2>
            {!selected ? (
              <p>Select a conversation to view its messages.</p>
            ) : messages.isLoading ? (
              <Skeleton />
            ) : messages.data?.items.length ? (
              messages.data.items.map((message) => (
                <p key={message.id}>
                  <Badge tone={message.direction === "INBOUND" ? "neutral" : "success"}>
                    {message.direction}
                  </Badge> <Badge>{message.status}</Badge> {message.body}
                </p>
              ))
            ) : (
              <p>No messages recorded.</p>
            )}
          </Card>
        </div>
      </section>
    </AccessGate>
  );
}
