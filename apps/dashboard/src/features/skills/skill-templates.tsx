"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Can } from "../admin/authorization";
import { Alert, Badge, Button, Dialog, EmptyState, Label, Skeleton } from "../../components/ui";
import { useApi, useAgentApi, queryKey } from "./skill-pages";
import type { SkillTemplate, SkillTemplateInstallResult } from "./skill-api";

/** Sprint 6.1B Feature 6 — Skill Templates tab. Installing a template bundles skills + default
 *  configuration onto a target employee — either an existing one the admin picks, or (when left
 *  blank) a brand-new employee of the template's `targetPluginId` created automatically. */
export function TemplatesTab() {
  const api = useApi();
  const agentApi = useAgentApi();
  const qc = useQueryClient();
  const [installTarget, setInstallTarget] = useState<SkillTemplate | null>(null);
  const [pluginInstallationId, setPluginInstallationId] = useState("");
  const [approveSensitivePermissions, setApproveSensitivePermissions] = useState(false);
  const [lastResult, setLastResult] = useState<{ templateKey: string; result: SkillTemplateInstallResult } | null>(null);

  const templates = useQuery({ queryKey: [...queryKey, "templates"], queryFn: api.listTemplates });
  const employees = useQuery({ queryKey: ["agents", "employees"], queryFn: agentApi.employees, enabled: installTarget !== null });

  const install = useMutation({
    mutationFn: (input: { templateKey: string; pluginInstallationId?: string; approveSensitivePermissions: boolean }) =>
      api.installTemplate(input),
    onSuccess: (result, variables) => {
      setLastResult({ templateKey: variables.templateKey, result });
      setInstallTarget(null);
      setPluginInstallationId("");
      setApproveSensitivePermissions(false);
      void qc.invalidateQueries({ queryKey: [...queryKey, "templates"] });
    }
  });

  if (templates.isLoading) return <Skeleton />;
  if (templates.isError)
    return (
      <Alert tone="danger" title="Unable to load skill templates">
        <Button onClick={() => templates.refetch()}>Retry</Button>
      </Alert>
    );
  if (!templates.data?.length)
    return <EmptyState title="No skill templates available" description="No skill templates have been published yet." />;

  return (
    <>
      {lastResult ? (
        <Alert tone="success" title={`Installed ${lastResult.templateKey}`}>
          Granted: {lastResult.result.installedSkills.join(", ") || "none"} · Employee: {lastResult.result.pluginInstallationId}
        </Alert>
      ) : null}
      <div className="admin-grid">
        {templates.data.map((template) => (
          <div key={template.id} className="admin-grid-card">
            <div>
              <h3>
                {template.icon ? `${template.icon} ` : ""}
                {template.name}
              </h3>
              <p>{template.description}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{template.category}</Badge>
              {template.industry ? <Badge>{template.industry}</Badge> : null}
              <Badge>v{template.version}</Badge>
              <Badge>Targets {template.targetPluginId}</Badge>
            </div>
            <p className="text-sm" style={{ color: "var(--muted)" }}>By {template.author}</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {template.items.map((item) => (
                <li key={item.id}>{item.skillKey}</li>
              ))}
            </ul>
            <div>
              <Badge>{template.installationCount} installation{template.installationCount === 1 ? "" : "s"}</Badge>
              <div className="admin-actions" style={{ marginTop: 8 }}>
                <Can permission="skill.install">
                  <Button onClick={() => setInstallTarget(template)}>Install</Button>
                </Can>
              </div>
            </div>
          </div>
        ))}
      </div>
      {install.isError ? (
        <Alert tone="danger" title="Template installation failed">
          {install.error instanceof Error ? install.error.message : null}
        </Alert>
      ) : null}

      <Dialog
        open={installTarget !== null}
        title={installTarget ? `Install ${installTarget.name}` : "Install template"}
        description="Pick an existing employee to grant these skills to, or leave blank to create a new employee automatically."
        confirmLabel="Install"
        onCancel={() => {
          setInstallTarget(null);
          setPluginInstallationId("");
          setApproveSensitivePermissions(false);
        }}
        onConfirm={() => {
          if (!installTarget) return;
          install.mutate({
            templateKey: installTarget.key,
            ...(pluginInstallationId ? { pluginInstallationId } : {}),
            approveSensitivePermissions
          });
        }}
      >
        {installTarget ? (
          <div className="admin-form">
            <Label htmlFor="template-employee-picker">Target employee (optional)</Label>
            {employees.isLoading ? (
              <Skeleton />
            ) : (
              <select
                id="template-employee-picker"
                className="ui-input"
                value={pluginInstallationId}
                onChange={(event) => setPluginInstallationId(event.target.value)}
              >
                <option value="">Create a new {installTarget.targetPluginId} employee</option>
                {(employees.data ?? []).map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.displayName}
                  </option>
                ))}
              </select>
            )}
            <label>
              <input
                type="checkbox"
                checked={approveSensitivePermissions}
                onChange={(event) => setApproveSensitivePermissions(event.target.checked)}
              />{" "}
              I approve any sensitive permissions these skills request
            </label>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
