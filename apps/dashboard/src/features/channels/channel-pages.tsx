"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { createAgentApi } from "../agents/agent-api";
import { Alert, Badge, BackLink, Button, Card, EmptyState, Input, Label, Skeleton } from "../../components/ui";
import { createChannelApi, type ChannelConfigurationInput, type MetaChannelConfigurationInput } from "./channel-api";

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

function safeError(error: unknown): string {
  const msg = typeof error === "object" && error !== null ? String((error as Record<string, unknown>).message ?? "") : "";
  const known: Record<string, string> = {
    CHANNEL_CONFIGURATION_INCOMPLETE: "Account SID, Auth Token, and sender number are all required.",
    META_CONFIGURATION_INCOMPLETE: "Access Token and Phone Number ID are required.",
    AGENT_NOT_FOUND: "Select an active AI employee to bind this channel to.",
    AGENT_NOT_ACTIVE: "The selected AI employee is not active.",
    CHANNEL_CREDENTIALS_REQUIRED: "Configure credentials before testing or enabling.",
    CHANNEL_PROVIDER_AUTHENTICATION_FAILED: "Provider rejected the configured credentials.",
    CHANNEL_PROVIDER_UNAVAILABLE: "Provider is currently unavailable.",
    CHANNEL_NOT_FOUND: "This channel is no longer available.",
    PHONE_NUMBER_ALREADY_IN_USE: "This WhatsApp number is already connected to another organisation.",
    META_CREDENTIAL_VERIFICATION_FAILED: "Meta rejected the access token or phone number ID.",
    META_SEND_FAILED: "Failed to send a test message through Meta."
  };
  for (const [code, text] of Object.entries(known)) {
    if (msg.includes(code)) return text;
  }
  return "Check the fields and try again.";
}

function ProviderBadge({ provider }: { provider: string }) {
  return <Badge tone={provider === "META_CLOUD_API" ? "warning" : "neutral"}>{provider === "META_CLOUD_API" ? "Meta WhatsApp" : "Twilio"}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, "success" | "warning" | "danger" | "neutral"> = {
    ACTIVE: "success", CONNECTED: "success", DISABLED: "neutral",
    DEGRADED: "warning", FAILED: "danger", DRAFT: "neutral"
  };
  return <Badge tone={tones[status] ?? "neutral"}>{status}</Badge>;
}

export function ChannelsPage() {
  const api = useApi();
  const [search, setSearch] = useState("");
  const channels = useQuery({ queryKey: [...key, "list", search], queryFn: () => api.list({ pageSize: 50, search }) });
  return (
    <AccessGate permission="channel.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div><h1>Channels</h1><p>Connect WhatsApp to your AI employees.</p></div>
          <Can permission="channel.create">
            <Link href="/channels/new"><Button>New channel</Button></Link>
          </Can>
        </header>
        <Card className="admin-toolbar">
          <Label htmlFor="channel-search">Search channels</Label>
          <Input id="channel-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </Card>
        {channels.isLoading ? <Skeleton /> : channels.isError ? (
          <Alert tone="danger" title="Unable to load channels"><Button onClick={() => channels.refetch()}>Retry</Button></Alert>
        ) : channels.data?.items.length ? (
          <div className="admin-table-wrap"><table className="admin-table">
            <thead><tr><th>Channel</th><th>Provider</th><th>Phone</th><th>Status</th><th>Bound agent</th><th>Action</th></tr></thead>
            <tbody>{channels.data.items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.name}</strong></td>
                <td><ProviderBadge provider={item.provider} /></td>
                <td>{item.displayPhoneNumber ?? item.configuration?.fromNumber ?? "—"}</td>
                <td><StatusBadge status={item.status} /></td>
                <td>{item.agent.displayName}</td>
                <td><Link href={`/channels/${item.id}`}>Manage</Link></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : (
          <EmptyState title="No channels configured" description="Create a WhatsApp channel to let customers message an AI employee." />
        )}
      </section>
    </AccessGate>
  );
}

export function NewChannelPage() {
  const api = useApi(), router = useRouter();
  const agents = useAgents();
  const [provider, setProvider] = useState<"TWILIO" | "META_CLOUD_API">("META_CLOUD_API");
  const create = useMutation({
    mutationFn: (body: {
      name: string; provider: "TWILIO" | "META_CLOUD_API"; channelType: "WHATSAPP";
      agentId: string; configuration: ChannelConfigurationInput | MetaChannelConfigurationInput;
    }) => api.create(body),
    onSuccess: (channel) => router.push(`/channels/${(channel as Record<string, unknown>).id}`)
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const agentId = String(data.get("agentId") ?? "");
    if (provider === "META_CLOUD_API") {
      const config: MetaChannelConfigurationInput = {
        metaAppId: String(data.get("metaAppId") ?? "").trim() || undefined,
        metaAppSecret: String(data.get("metaAppSecret") ?? "").trim() || undefined,
        whatsappBusinessAccountId: String(data.get("wabaId") ?? "").trim() || undefined,
        phoneNumberId: String(data.get("phoneNumberId") ?? "").trim(),
        displayPhoneNumber: String(data.get("displayPhoneNumber") ?? "").trim() || undefined,
        accessToken: String(data.get("accessToken") ?? "").trim(),
        webhookVerifyToken: String(data.get("webhookVerifyToken") ?? "").trim() || undefined,
        apiVersion: String(data.get("apiVersion") ?? "").trim() || undefined
      };
      create.mutate({ name, provider: "META_CLOUD_API", channelType: "WHATSAPP", agentId, configuration: config });
    } else {
      const config: ChannelConfigurationInput = {
        accountSid: String(data.get("accountSid") ?? "").trim(),
        authToken: String(data.get("authToken") ?? "").trim(),
        fromNumber: String(data.get("fromNumber") ?? "").trim()
      };
      create.mutate({ name, provider: "TWILIO", channelType: "WHATSAPP", agentId, configuration: config });
    }
  };
  return (
    <AccessGate permission="channel.create">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <BackLink href="/channels" label="Back to Channels" />
            <h1>New WhatsApp channel</h1>
          </div>
        </header>
        <Card>
          <div className="admin-toolbar">
            <Label>Provider</Label>
            <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="META_CLOUD_API">Meta Cloud API (recommended)</option>
              <option value="TWILIO">Twilio (legacy)</option>
            </select>
          </div>
          <form className="admin-form" onSubmit={submit}>
            <Label htmlFor="channel-name">Connection name</Label>
            <Input id="channel-name" name="name" required maxLength={160} placeholder="Sales WhatsApp" />
            <Label htmlFor="channel-agent">Bound AI employee</Label>
            <select id="channel-agent" name="agentId" required disabled={agents.isLoading}>
              <option value="">Select an AI employee…</option>
              {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
            </select>
            {provider === "META_CLOUD_API" ? (
              <>
                <Label htmlFor="meta-app-id">Meta App ID</Label>
                <Input id="meta-app-id" name="metaAppId" placeholder="From Meta Business App" />
                <Label htmlFor="meta-app-secret">Meta App Secret</Label>
                <Input id="meta-app-secret" name="metaAppSecret" type="password" autoComplete="new-password" />
                <Label htmlFor="waba-id">WhatsApp Business Account ID</Label>
                <Input id="waba-id" name="wabaId" placeholder="From Meta Business Manager" />
                <Label htmlFor="phone-number-id">Phone Number ID</Label>
                <Input id="phone-number-id" name="phoneNumberId" required placeholder="From Meta WhatsApp > API Setup" />
                <Label htmlFor="display-phone-number">Display phone number</Label>
                <Input id="display-phone-number" name="displayPhoneNumber" placeholder="+971501234567" />
                <Label htmlFor="access-token">Access Token</Label>
                <Input id="access-token" name="accessToken" type="password" autoComplete="new-password" required />
                <Label htmlFor="webhook-verify-token">Webhook Verify Token</Label>
                <Input id="webhook-verify-token" name="webhookVerifyToken" type="password" autoComplete="new-password" placeholder="Choose a secret token for webhook verification" />
                <Label htmlFor="api-version">API Version</Label>
                <Input id="api-version" name="apiVersion" placeholder="v22.0" defaultValue="v22.0" />
              </>
            ) : (
              <>
                <Label htmlFor="accountSid">Twilio Account SID</Label>
                <Input id="accountSid" name="accountSid" required placeholder="AC…" />
                <Label htmlFor="authToken">Twilio Auth Token</Label>
                <Input id="authToken" name="authToken" type="password" autoComplete="new-password" required />
                <Label htmlFor="fromNumber">WhatsApp sender number</Label>
                <Input id="fromNumber" name="fromNumber" required placeholder="+14155238886" />
              </>
            )}
            {create.isError ? <Alert tone="danger" title="Channel was not created">{safeError(create.error)}</Alert> : null}
            <Button type="submit" loading={create.isPending} disabled={create.isPending}>Create channel</Button>
          </form>
        </Card>
      </section>
    </AccessGate>
  );
}

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>(), api = useApi(), qc = useQueryClient(), router = useRouter();
  const agents = useAgents();
  const channel = useQuery({ queryKey: [...key, id], queryFn: () => api.get(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const update = useMutation({ mutationFn: (body: { name?: string; agentId?: string; configuration?: ChannelConfigurationInput | MetaChannelConfigurationInput }) => api.update(id, body), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (name: "enable" | "disable") => api[name](id), onSuccess: refresh });
  const test = useMutation({ mutationFn: () => api.test(id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.remove(id), onSuccess: () => router.push("/channels") });
  const [copied, setCopied] = useState(false);
  if (channel.isLoading) return <Skeleton />;
  if (!channel.data) return <EmptyState title="Channel not found" description="It may have been archived." />;
  const item = channel.data;
  const isMeta = item.provider === "META_CLOUD_API";

  const submitMeta = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const agentId = String(data.get("agentId") ?? "");
    const metaAppId = String(data.get("metaAppId") ?? "").trim();
    const accessToken = String(data.get("accessToken") ?? "").trim();
    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (agentId) body.agentId = agentId;
    const config: MetaChannelConfigurationInput = {};
    if (metaAppId) config.metaAppId = metaAppId;
    if (accessToken) config.accessToken = accessToken;
    const wabaId = String(data.get("wabaId") ?? "").trim();
    if (wabaId) config.whatsappBusinessAccountId = wabaId;
    const phoneNumberId = String(data.get("phoneNumberId") ?? "").trim();
    if (phoneNumberId) config.phoneNumberId = phoneNumberId;
    const display = String(data.get("displayPhoneNumber") ?? "").trim();
    if (display) config.displayPhoneNumber = display;
    const appSecret = String(data.get("metaAppSecret") ?? "").trim();
    if (appSecret) config.metaAppSecret = appSecret;
    const verifyToken = String(data.get("webhookVerifyToken") ?? "").trim();
    if (verifyToken) config.webhookVerifyToken = verifyToken;
    const apiVersion = String(data.get("apiVersion") ?? "").trim();
    if (apiVersion) config.apiVersion = apiVersion;
    if (Object.keys(config).length > 0) body.configuration = config;
    update.mutate(body as Parameters<typeof update.mutate>[0]);
  };

  const submitTwilio = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const agentId = String(data.get("agentId") ?? "");
    const config: ChannelConfigurationInput = {
      accountSid: String(data.get("accountSid") ?? "").trim() || undefined,
      authToken: String(data.get("authToken") ?? "").trim() || undefined,
      fromNumber: String(data.get("fromNumber") ?? "").trim() || undefined
    };
    update.mutate({ ...(name ? { name } : {}), ...(agentId ? { agentId } : {}), ...(Object.values(config).some(Boolean) ? { configuration: config } : {}) });
  };

  return (
    <AccessGate permission="channel.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <BackLink href="/channels" label="Back to Channels" />
            <h1>{item.name}</h1>
            <p><ProviderBadge provider={item.provider} /> · bound to {item.agent.displayName}</p>
          </div>
          <StatusBadge status={item.status} />
        </header>
        <Card className="admin-toolbar">
          <Can permission="channel.test"><Button loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button></Can>
          <Can permission="channel.update">
            {item.status === "ACTIVE" ? (
              <Button variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate("disable")}>Disable</Button>
            ) : (
              <Button loading={toggle.isPending} onClick={() => toggle.mutate("enable")}>Enable</Button>
            )}
          </Can>
          <span>Last tested: {item.lastTestedAt ? new Date(item.lastTestedAt).toLocaleString() : "Never"} {item.lastTestStatus ? <Badge>{item.lastTestStatus}</Badge> : null}</span>
        </Card>
        {toggle.isError ? <Alert tone="danger" title="Action failed">{safeError(toggle.error)}</Alert> : null}
        {test.isError ? <Alert tone="danger" title="Test failed">{safeError(test.error)}</Alert> : null}
        {test.isSuccess ? <Alert tone="success" title="Connection successful">{test.data?.status ?? "Connected"}</Alert> : null}

        {isMeta ? (
          <Card>
            <h2>Meta WhatsApp Configuration</h2>
            <div className="admin-grid">
              <div><Label>WhatsApp Business Account ID</Label><p>{item.whatsappBusinessAccountId ?? "—"}</p></div>
              <div><Label>Phone Number ID</Label><p>{item.phoneNumberId ?? "—"}</p></div>
              <div><Label>Display Phone Number</Label><p>{item.displayPhoneNumber ?? "—"}</p></div>
              <div><Label>Credentials</Label><p>{item.hasAuthToken ? "Configured" : "Not configured"}</p></div>
              <div><Label>Onboarding</Label><p>{item.onboardingMode === "EMBEDDED_SIGNUP" ? "Embedded Signup" : "Manual"}</p></div>
            </div>
          </Card>
        ) : (
          <Card>
            <h2>Twilio Configuration</h2>
            <div className="admin-grid">
              <div><Label>Account SID</Label><p>{item.configuration?.accountSid ?? "—"}</p></div>
              <div><Label>From number</Label><p>{item.configuration?.fromNumber ?? "—"}</p></div>
              <div><Label>Auth Token</Label><p>{item.hasAuthToken ? "Configured" : "Not configured"}</p></div>
            </div>
          </Card>
        )}

        <Card>
          <h2>Webhook URL</h2>
          <p>Configure this URL in your {isMeta ? "Meta WhatsApp > Webhook settings" : "Twilio WhatsApp sender"}.</p>
          <Input readOnly value={item.webhookUrl} aria-label="Webhook URL" />
          <Button type="button" onClick={() => { void navigator.clipboard.writeText(item.webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </Card>

        <Card>
          <h2>Employee Routing</h2>
          <div className="admin-grid">
            <div><Label>Routing mode</Label><p>{item.routingMode === "INTENT_ROUTER" ? "Intent Router (recommended)" : "Fixed employee"}</p></div>
            <div><Label>Employees available</Label><p>{(item.allowedEmployeeIds ?? []).length} employee(s) configured</p></div>
          </div>
          {(!item.allowedEmployeeIds || item.allowedEmployeeIds.length <= 1) ? (
            <p>Only one AI Employee is currently available. Requests outside its configured scope will not be answered.</p>
          ) : null}
        </Card>

        {item.lastErrorCode ? <Card><h3>Last error</h3><p className="danger-text">{item.lastErrorCode}: {item.lastErrorMessage ?? "Unknown"}</p></Card> : null}

        <Can permission="channel.delete">
          <Card><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Remove channel</Button></Card>
        </Can>

        <Can permission="channel.update">
          <Card><h2>{isMeta ? "Edit Meta Configuration" : "Edit Twilio Configuration"}</h2>
            <form className="admin-form" onSubmit={isMeta ? submitMeta : submitTwilio}>
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" name="name" defaultValue={item.name} maxLength={160} />
              <Label htmlFor="edit-agent">Bound AI employee</Label>
              <select id="edit-agent" name="agentId" defaultValue={item.agentId} disabled={agents.isLoading}>
                <option value="">Select…</option>
                {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
              </select>
              {isMeta ? (
                <>
                  <Label htmlFor="edit-meta-app-id">Meta App ID</Label>
                  <Input id="edit-meta-app-id" name="metaAppId" defaultValue={item.configuration?.metaAppId ?? ""} />
                  <Label htmlFor="edit-meta-app-secret">Meta App Secret {item.hasAuthToken ? "(leave blank to keep current)" : ""}</Label>
                  <Input id="edit-meta-app-secret" name="metaAppSecret" type="password" autoComplete="new-password" />
                  <Label htmlFor="edit-waba-id">WABA ID</Label>
                  <Input id="edit-waba-id" name="wabaId" defaultValue={item.whatsappBusinessAccountId ?? ""} />
                  <Label htmlFor="edit-phone-number-id">Phone Number ID</Label>
                  <Input id="edit-phone-number-id" name="phoneNumberId" defaultValue={item.phoneNumberId ?? ""} />
                  <Label htmlFor="edit-display-phone">Display Phone</Label>
                  <Input id="edit-display-phone" name="displayPhoneNumber" defaultValue={item.displayPhoneNumber ?? ""} />
                  <Label htmlFor="edit-access-token">Access Token {item.hasAuthToken ? "(leave blank to keep current)" : ""}</Label>
                  <Input id="edit-access-token" name="accessToken" type="password" autoComplete="new-password" />
                  <Label htmlFor="edit-webhook-verify-token">Webhook Verify Token {item.hasAuthToken ? "(leave blank to keep current)" : ""}</Label>
                  <Input id="edit-webhook-verify-token" name="webhookVerifyToken" type="password" autoComplete="new-password" />
                  <Label htmlFor="edit-api-version">API Version</Label>
                  <Input id="edit-api-version" name="apiVersion" defaultValue={item.configuration?.apiVersion ?? "v22.0"} />
                </>
              ) : (
                <>
                  <Label htmlFor="edit-account-sid">Account SID</Label>
                  <Input id="edit-account-sid" name="accountSid" defaultValue={item.configuration?.accountSid ?? ""} />
                  <Label htmlFor="edit-auth-token">Auth Token {item.hasAuthToken ? "(leave blank to keep current)" : ""}</Label>
                  <Input id="edit-auth-token" name="authToken" type="password" autoComplete="new-password" />
                  <Label htmlFor="edit-from-number">From number</Label>
                  <Input id="edit-from-number" name="fromNumber" defaultValue={item.configuration?.fromNumber ?? ""} />
                </>
              )}
              <Button type="submit" loading={update.isPending} disabled={update.isPending}>Save changes</Button>
            </form>
          </Card>
        </Can>
      </section>
    </AccessGate>
  );
}
