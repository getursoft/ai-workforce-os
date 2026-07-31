"use client";
import Link from "next/link";
import { useMemo, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can, useEffectivePermissions } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Button, Card, Input, Skeleton } from "../../components/ui";
import { ApiError } from "../../lib/api-error";
import { createPluginApi } from "../plugins/plugin-api";
import { EmailConfigurationForm } from "../plugins/email-configuration-form";
import {
  createEmployeeApi,
  type EmployeeConfigurationInput
} from "./employee-api";

const BRAND_TONES = ["FRIENDLY", "FORMAL", "CASUAL", "PROFESSIONAL"] as const;

export interface EmployeePageSpec {
  pluginId: string;
  permissionPrefix: string;
  artifactNoun: string;
  title: string;
  description: string;
  basePath: string;
  artifactEndpoint: string;
  fallbackDescription: string;
  /** Whether the "use real API" toggle + API endpoint/key fields appear on this employee's config form.
   *  False for the Legal employee (which relies on knowledge + LLM + PDFs instead of a real API). */
  showApiToggle?: boolean;
  /** Whether a "default country/jurisdiction" field appears on this employee's config form. Only the
   *  Legal employee uses it (verdicts/notices default to the configured country, e.g. India). */
  showCountryField?: boolean;
}

function usePluginApi() {
  const { client } = useAuth();
  return useMemo(() => createPluginApi(client), [client]);
}

/** Shared configuration page for every non-Travel domain employee. Mirrors the Travel Employee page's
 *  layout/orientation exactly: install card when uninstalled, then a status/toggle card, the configuration
 *  form, and the email-delivery section. Each employee supplies a {@link EmployeePageSpec}. */
export function EmployeePage({ spec }: { spec: EmployeePageSpec }) {
  const { client } = useAuth();
  const plugins = usePluginApi();
  const employee = useMemo(
    () => createEmployeeApi(client, spec.basePath, spec.artifactEndpoint),
    [client, spec.basePath, spec.artifactEndpoint]
  );
  const qc = useQueryClient();
  const key = [spec.pluginId] as const;
  const available = useQuery({ queryKey: [...key, "available"], queryFn: plugins.available });
  const installedList = useQuery({
    queryKey: [...key, "installed"],
    queryFn: () => plugins.list({ page: 1, pageSize: 50 })
  });
  const installedPlugin =
    installedList.data?.items.find((item) => item.slug === spec.pluginId) ?? null;
  const manifest = available.data?.items.find((item) => item.id === spec.pluginId) ?? null;

  const install = useMutation({
    mutationFn: () => {
      if (!manifest) throw new Error("EMPLOYEE_MANIFEST_UNAVAILABLE");
      return plugins.install({
        pluginId: spec.pluginId,
        grantedPermissions: manifest.permissions,
        enable: true,
        configuration: { config: {}, secrets: {} }
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key })
  });

  const toggle = useMutation({
    mutationFn: (active: boolean) => {
      if (!installedPlugin) throw new Error("EMPLOYEE_NOT_INSTALLED");
      return active ? plugins.enable(installedPlugin.id) : plugins.disable(installedPlugin.id);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key })
  });

  return (
    <AccessGate permission={`${spec.permissionPrefix}.config.read`}>
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>{spec.title}</h1>
            <p>{spec.description}</p>
          </div>
        </header>
        {installedList.isLoading || available.isLoading ? (
          <Skeleton />
        ) : !installedPlugin ? (
          <Card>
            <h2>Install the {spec.title}</h2>
            <p>{manifest?.description ?? spec.fallbackDescription}</p>
            <Can permission="plugin.install">
              <Button
                loading={install.isPending}
                disabled={install.isPending || !manifest}
                onClick={() => install.mutate()}
              >
                Install {spec.title}
              </Button>
            </Can>
            {install.isError ? (
              <Alert tone="danger" title="Installation failed">
                {employeeErrorMessage(install.error, spec)}
              </Alert>
            ) : null}
          </Card>
        ) : (
          <>
            <Card>
              <Badge tone={installedPlugin.status === "ACTIVE" ? "success" : "warning"}>
                {installedPlugin.status}
              </Badge>{" "}
              <Can permission="plugin.update">
                <Button
                  onClick={() => toggle.mutate(installedPlugin.status !== "ACTIVE")}
                  loading={toggle.isPending}
                >
                  {installedPlugin.status === "ACTIVE" ? "Disable" : "Enable"}
                </Button>
              </Can>
              <p>
                <Link href={`/ai-employees/${installedPlugin.id}`}>
                  Chat with the {spec.title}
                </Link>
                {" · "}
                <Link href="/conversations">View conversations</Link>
              </p>
            </Card>
            <ConfigurationForm spec={spec} pluginInstallationId={installedPlugin.id} api={employee} />
            <EmailDeliverySection pluginInstallationId={installedPlugin.id} api={plugins} />
          </>
        )}
      </section>
    </AccessGate>
  );
}

function EmailDeliverySection({
  pluginInstallationId,
  api
}: {
  pluginInstallationId: string;
  api: ReturnType<typeof createPluginApi>;
}) {
  const { state } = useAuth();
  const canManage = state.user?.role === "OWNER" || state.user?.role === "ADMIN";
  const q = useQuery({
    queryKey: ["employee-email-configuration", pluginInstallationId],
    queryFn: () => api.emailConfiguration(pluginInstallationId)
  });
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.updateEmailConfiguration>[1]) =>
      api.updateEmailConfiguration(pluginInstallationId, body),
    onSuccess: () => void q.refetch()
  });
  if (q.isLoading) return <Skeleton />;
  return (
    <Card>
      <EmailConfigurationForm
        configuration={q.data}
        canManage={canManage}
        saving={save.isPending}
        save={(body) => save.mutate(body)}
        saveError={save.isError ? save.error : null}
        saveSucceeded={save.isSuccess}
      />
    </Card>
  );
}

function ConfigurationForm({
  spec,
  pluginInstallationId,
  api
}: {
  spec: EmployeePageSpec;
  pluginInstallationId: string;
  api: ReturnType<typeof createEmployeeApi>;
}) {
  const permissions = useEffectivePermissions();
  const canUpdate = permissions.has(`${spec.permissionPrefix}.config.update`);
  const key = [spec.pluginId, "configuration", pluginInstallationId] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.configuration(pluginInstallationId)
  });
  const save = useMutation({
    mutationFn: (body: EmployeeConfigurationInput) => api.updateConfiguration(pluginInstallationId, body),
    onSuccess: () => void q.refetch()
  });
  if (q.isLoading) return <Skeleton />;
  if (q.isError)
    return (
      <Alert tone="danger" title="Unable to load configuration">
        {employeeErrorMessage(q.error, spec)}
      </Alert>
    );
  const config = q.data;
  if (!canUpdate)
    return (
      <Card>
        <h2>Configuration</h2>
        <p>You do not have permission to update this configuration.</p>
      </Card>
    );
  return (
    <Card>
      <h2>Configuration</h2>
      <form
        className="admin-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = (name: string) => String(data.get(name) ?? "").trim();
          const apiEnabled = spec.showApiToggle ? data.get("apiEnabled") !== null : undefined;
          save.mutate({
            ...(value("persona") ? { persona: value("persona") } : {}),
            ...(value("welcomeMessage") ? { welcomeMessage: value("welcomeMessage") } : {}),
            ...(value("businessHoursTimezone")
              ? { businessHoursTimezone: value("businessHoursTimezone") }
              : {}),
            ...(value("businessHoursStart") ? { businessHoursStart: value("businessHoursStart") } : {}),
            ...(value("businessHoursEnd") ? { businessHoursEnd: value("businessHoursEnd") } : {}),
            ...(value("escalationContact") ? { escalationContact: value("escalationContact") } : {}),
            ...(value("brandTone") ? { brandTone: value("brandTone") } : {}),
            ...(value("defaultCurrency")
              ? { defaultCurrency: value("defaultCurrency").toUpperCase() }
              : {}),
            ...(value("defaultLanguage") ? { defaultLanguage: value("defaultLanguage") } : {}),
            ...(spec.showApiToggle
              ? {
                  ...(apiEnabled !== undefined ? { apiEnabled } : {}),
                  ...(value("apiEndpoint") ? { apiEndpoint: value("apiEndpoint") } : {}),
                  ...(value("apiKey") ? { apiKey: value("apiKey") } : {})
                }
              : {}),
            ...(spec.showCountryField
              ? { ...(value("defaultCountry") ? { defaultCountry: value("defaultCountry") } : {}) }
              : {})
          });
        }}
      >
        <label htmlFor="persona">Persona</label>
        <textarea
          id="persona"
          name="persona"
          className="ui-input"
          defaultValue={config?.persona}
          maxLength={2000}
          rows={3}
        />

        <label htmlFor="welcomeMessage">Welcome message</label>
        <Input
          id="welcomeMessage"
          name="welcomeMessage"
          defaultValue={config?.welcomeMessage}
          maxLength={1000}
        />

        <label htmlFor="escalationContact">Escalation contact</label>
        <Input
          id="escalationContact"
          name="escalationContact"
          placeholder="support@example.com"
          defaultValue={config?.escalationContact}
          maxLength={255}
        />

        <label htmlFor="brandTone">Brand tone</label>
        <select id="brandTone" name="brandTone" className="ui-input" defaultValue={config?.brandTone}>
          {BRAND_TONES.map((tone) => (
            <option key={tone} value={tone}>
              {tone}
            </option>
          ))}
        </select>

        <label htmlFor="defaultCurrency">Default currency</label>
        <Input id="defaultCurrency" name="defaultCurrency" defaultValue={config?.defaultCurrency} maxLength={3} />

        <label htmlFor="defaultLanguage">Default language</label>
        <Input id="defaultLanguage" name="defaultLanguage" defaultValue={config?.defaultLanguage} maxLength={10} />

        <label htmlFor="businessHoursStart">Business hours start (HH:MM)</label>
        <Input
          id="businessHoursStart"
          name="businessHoursStart"
          placeholder="09:00"
          defaultValue={config?.businessHoursStart ?? ""}
        />

        <label htmlFor="businessHoursEnd">Business hours end (HH:MM)</label>
        <Input
          id="businessHoursEnd"
          name="businessHoursEnd"
          placeholder="18:00"
          defaultValue={config?.businessHoursEnd ?? ""}
        />

        <label htmlFor="businessHoursTimezone">Business hours timezone</label>
        <Input
          id="businessHoursTimezone"
          name="businessHoursTimezone"
          placeholder="Asia/Kolkata"
          defaultValue={config?.businessHoursTimezone ?? ""}
        />

        {spec.showApiToggle ? (
          <fieldset className="admin-form__api">
            <legend>Real API integration</legend>
            <p>
              When switched ON, this employee calls the real backend API you configure below instead of the
              built-in flow. Leave it OFF to keep using the built-in flow.
            </p>
            <label className="api-toggle">
              <input
                type="checkbox"
                name="apiEnabled"
                defaultChecked={config?.apiEnabled === true}
              />{" "}
              Use real API
            </label>
            <label htmlFor="apiEndpoint">API endpoint</label>
            <Input
              id="apiEndpoint"
              name="apiEndpoint"
              placeholder="https://your-backend.example.com/api/chat"
              defaultValue={config?.apiEndpoint ?? ""}
              maxLength={500}
            />
            <label htmlFor="apiKey">API key</label>
            <Input
              id="apiKey"
              name="apiKey"
              placeholder="Bearer token or API key"
              defaultValue={config?.apiKey ?? ""}
              maxLength={500}
            />
          </fieldset>
        ) : null}

        {spec.showCountryField ? (
          <fieldset className="admin-form__api">
            <legend>Jurisdiction</legend>
            <p>
              Legal queries and verdicts default to this country's courts and laws unless the user
              explicitly asks about another country.
            </p>
            <label htmlFor="defaultCountry">Default country</label>
            <Input
              id="defaultCountry"
              name="defaultCountry"
              placeholder="India"
              defaultValue={config?.defaultCountry ?? "India"}
              maxLength={80}
            />
          </fieldset>
        ) : null}

        {save.isError ? (
          <Alert tone="danger" title="Unable to save configuration">
            {employeeErrorMessage(save.error, spec)}
          </Alert>
        ) : null}
        {save.isSuccess ? <Alert tone="success" title="Configuration saved" /> : null}
        <Button type="submit" loading={save.isPending} disabled={save.isPending}>
          Save configuration
        </Button>
      </form>
    </Card>
  );
}

export function employeeErrorMessage(error: unknown, spec: EmployeePageSpec): string {
  if (!(error instanceof ApiError)) return "The request could not be completed safely.";
  const messages: Record<string, string> = {
    EMPLOYEE_NOT_FOUND: `The ${spec.title} is not installed for this organization.`,
    EMPLOYEE_MANIFEST_UNAVAILABLE: `The ${spec.title} package is not available to install.`,
    CONVERSATION_NOT_FOUND: "That conversation could not be found.",
    PLUGIN_ALREADY_INSTALLED: `The ${spec.title} is already installed.`
  };
  return messages[error.code] ?? "The request could not be completed safely.";
}
