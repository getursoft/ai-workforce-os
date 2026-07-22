"use client";
import Link from "next/link";
import { useMemo, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AccessGate, Can, useEffectivePermissions } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { Alert, Badge, Button, Card, Input, Skeleton } from "../../components/ui";
import { ApiError } from "../../lib/api-error";
import { createPluginApi } from "../plugins/plugin-api";
import {
  createTravelApi,
  TRAVEL_EMPLOYEE_PLUGIN_ID,
  type TravelConfigurationInput
} from "./travel-api";

const BRAND_TONES = ["FRIENDLY", "FORMAL", "CASUAL", "PROFESSIONAL"] as const;
const key = ["travel-employee"] as const;

function usePluginApi() {
  const { client } = useAuth();
  return useMemo(() => createPluginApi(client), [client]);
}
function useTravelApi() {
  const { client } = useAuth();
  return useMemo(() => createTravelApi(client), [client]);
}

export function TravelEmployeePage() {
  const plugins = usePluginApi();
  const travel = useTravelApi();
  const qc = useQueryClient();

  const available = useQuery({ queryKey: [...key, "available"], queryFn: plugins.available });
  const installedList = useQuery({
    queryKey: [...key, "installed"],
    queryFn: () => plugins.list({ page: 1, pageSize: 50 })
  });
  const installedPlugin =
    installedList.data?.items.find((item) => item.slug === TRAVEL_EMPLOYEE_PLUGIN_ID) ?? null;
  const manifest = available.data?.items.find((item) => item.id === TRAVEL_EMPLOYEE_PLUGIN_ID) ?? null;

  const install = useMutation({
    mutationFn: () => {
      if (!manifest) throw new Error("TRAVEL_EMPLOYEE_MANIFEST_UNAVAILABLE");
      return plugins.install({
        pluginId: TRAVEL_EMPLOYEE_PLUGIN_ID,
        grantedPermissions: manifest.permissions,
        enable: true,
        configuration: { config: {}, secrets: {} }
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key })
  });

  const toggle = useMutation({
    mutationFn: (active: boolean) => {
      if (!installedPlugin) throw new Error("TRAVEL_EMPLOYEE_NOT_INSTALLED");
      return active ? plugins.enable(installedPlugin.id) : plugins.disable(installedPlugin.id);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key })
  });

  return (
    <AccessGate permission="travel.config.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Travel Employee</h1>
            <p>Configure the AI travel planning employee shared by Dashboard chat and WhatsApp.</p>
          </div>
        </header>
        {installedList.isLoading || available.isLoading ? (
          <Skeleton />
        ) : !installedPlugin ? (
          <Card>
            <h2>Install the Travel Employee</h2>
            <p>
              {manifest?.description ??
                "Collects destination, dates, passengers, and budget; searches placeholder flights and hotels; and produces an itinerary summary. Never claims a booking occurred."}
            </p>
            <Can permission="plugin.install">
              <Button
                loading={install.isPending}
                disabled={install.isPending || !manifest}
                onClick={() => install.mutate()}
              >
                Install Travel Employee
              </Button>
            </Can>
            {install.isError ? (
              <Alert tone="danger" title="Installation failed">
                {travelErrorMessage(install.error)}
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
                <Link href={`/ai-employees?plugin=${installedPlugin.id}`}>
                  Chat with the Travel Employee
                </Link>
                {" · "}
                <Link href="/conversations">View conversations</Link>
              </p>
            </Card>
            <ConfigurationForm pluginInstallationId={installedPlugin.id} api={travel} />
          </>
        )}
      </section>
    </AccessGate>
  );
}

function ConfigurationForm({
  pluginInstallationId,
  api
}: {
  pluginInstallationId: string;
  api: ReturnType<typeof createTravelApi>;
}) {
  const permissions = useEffectivePermissions();
  const canUpdate = permissions.has("travel.config.update");
  const q = useQuery({
    queryKey: [...key, "configuration", pluginInstallationId],
    queryFn: () => api.configuration(pluginInstallationId)
  });
  const save = useMutation({
    mutationFn: (body: TravelConfigurationInput) => api.updateConfiguration(pluginInstallationId, body),
    onSuccess: () => void q.refetch()
  });
  if (q.isLoading) return <Skeleton />;
  if (q.isError)
    return (
      <Alert tone="danger" title="Unable to load configuration">
        {travelErrorMessage(q.error)}
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
            ...(value("defaultLanguage") ? { defaultLanguage: value("defaultLanguage") } : {})
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

        {save.isError ? (
          <Alert tone="danger" title="Unable to save configuration">
            {travelErrorMessage(save.error)}
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

export function travelErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "The request could not be completed safely.";
  const messages: Record<string, string> = {
    TRAVEL_EMPLOYEE_NOT_FOUND: "The Travel Employee is not installed for this organization.",
    CONVERSATION_NOT_FOUND: "That conversation could not be found.",
    TRAVEL_EMPLOYEE_MANIFEST_UNAVAILABLE: "The Travel Employee package is not available to install.",
    PLUGIN_ALREADY_INSTALLED: "The Travel Employee is already installed."
  };
  return messages[error.code] ?? "The request could not be completed safely.";
}
