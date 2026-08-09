"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Can } from "../admin/authorization";
import { Alert, Badge, Button, Dialog, EmptyState, Skeleton } from "../../components/ui";
import { useApi, queryKey } from "./skill-pages";
import type { SkillPack, SkillPackInstallResult } from "./skill-api";

function outcomeTone(outcome: string): "neutral" | "success" | "warning" | "danger" {
  if (outcome === "INSTALLED" || outcome === "ALREADY_INSTALLED") return "success";
  if (outcome === "FAILED") return "danger";
  return "neutral";
}

/** Sprint 6.1B Feature 5 — Skill Packs tab. Curated bundles of skills installed as a unit. Removing a
 *  pack only removes the pack-level bookkeeping row (never uninstalls the underlying skills), so the
 *  Remove confirmation copy says so explicitly. */
export function PacksTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [installTarget, setInstallTarget] = useState<SkillPack | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SkillPack | null>(null);
  const [results, setResults] = useState<Record<string, SkillPackInstallResult>>({});

  const packs = useQuery({ queryKey: [...queryKey, "packs"], queryFn: api.listPacks });
  const refresh = () => qc.invalidateQueries({ queryKey: [...queryKey, "packs"] });

  const install = useMutation({
    mutationFn: (input: { packKey: string; approveSensitivePermissions: boolean }) =>
      api.installPack(input.packKey, input.approveSensitivePermissions),
    onSuccess: (result, variables) => {
      setResults((current) => ({ ...current, [variables.packKey]: result }));
      setInstallTarget(null);
      refresh();
    }
  });

  const update = useMutation({
    mutationFn: (packKey: string) => api.updatePack(packKey),
    onSuccess: (result, packKey) => {
      setResults((current) => ({ ...current, [packKey]: result }));
      refresh();
    }
  });

  const remove = useMutation({
    mutationFn: (packKey: string) => api.removePack(packKey),
    onSuccess: (_data, packKey) => {
      setResults((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== packKey))
      );
      setRemoveTarget(null);
      refresh();
    }
  });

  if (packs.isLoading) return <Skeleton />;
  if (packs.isError)
    return (
      <Alert tone="danger" title="Unable to load skill packs">
        <Button onClick={() => packs.refetch()}>Retry</Button>
      </Alert>
    );
  if (!packs.data?.length)
    return <EmptyState title="No skill packs available" description="No skill packs have been published yet." />;

  return (
    <>
      <div className="admin-grid">
        {packs.data.map((pack) => (
          <div key={pack.id} className="admin-grid-card">
            <div>
              <h3>
                {pack.icon ? `${pack.icon} ` : ""}
                {pack.name}
              </h3>
              <p>{pack.description}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge>{pack.category}</Badge>
              {pack.industry ? <Badge>{pack.industry}</Badge> : null}
              <Badge>v{pack.version}</Badge>
            </div>
            <p className="text-sm" style={{ color: "var(--muted)" }}>By {pack.author}</p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {pack.items.map((item) => (
                <li key={item.id}>
                  {item.skillKey}{" "}
                  {item.required ? <Badge tone="warning">Required</Badge> : <Badge>Optional</Badge>}
                </li>
              ))}
            </ul>
            {pack.installed ? (
              <div>
                <Badge tone={pack.installation?.status === "PARTIAL" ? "warning" : "success"}>
                  Installed{pack.installation ? ` (${pack.installation.status})` : ""}
                </Badge>
                <div className="admin-actions" style={{ marginTop: 8 }}>
                  <Can permission="skill.update">
                    <Button
                      variant="secondary"
                      loading={update.isPending}
                      onClick={() => update.mutate(pack.key)}
                    >
                      Update
                    </Button>
                  </Can>
                  <Can permission="skill.uninstall">
                    <Button variant="danger" onClick={() => setRemoveTarget(pack)}>
                      Remove
                    </Button>
                  </Can>
                </div>
              </div>
            ) : (
              <Can permission="skill.install">
                <Button onClick={() => setInstallTarget(pack)}>Install Pack</Button>
              </Can>
            )}
            {(() => {
              const packResult = results[pack.key];
              if (!packResult) return null;
              return (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Skill</th>
                        <th>Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {packResult.results.map((outcome) => (
                        <tr key={outcome.skillKey}>
                          <td>{outcome.skillKey}</td>
                          <td>
                            <Badge tone={outcomeTone(outcome.outcome)}>{outcome.outcome}</Badge>
                            {outcome.error ? <small title={outcome.error}> — {outcome.error}</small> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
        ))}
      </div>
      {install.isError ? (
        <Alert tone="danger" title="Pack installation failed">
          {install.error instanceof Error ? install.error.message : null}
        </Alert>
      ) : null}
      {update.isError ? <Alert tone="danger" title="Pack update failed" /> : null}
      {remove.isError ? <Alert tone="danger" title="Pack removal failed" /> : null}

      <Dialog
        open={installTarget !== null}
        title={installTarget ? `Install ${installTarget.name}` : "Install pack"}
        description="Every skill in this pack that isn't already installed will be installed, in dependency-safe order."
        confirmLabel="Install"
        onCancel={() => setInstallTarget(null)}
        onConfirm={() => {
          const checkbox = document.getElementById("pack-approve-sensitive") as HTMLInputElement | null;
          if (installTarget) install.mutate({ packKey: installTarget.key, approveSensitivePermissions: checkbox?.checked ?? false });
        }}
      >
        {installTarget ? (
          <label>
            <input type="checkbox" id="pack-approve-sensitive" />{" "}
            I approve any sensitive permissions these skills request
          </label>
        ) : null}
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        title="Remove this pack?"
        description="This removes the pack-level bookkeeping only — the underlying skills stay installed, since another pack or a manual install may still depend on them."
        confirmLabel="Remove"
        destructive
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.key);
        }}
      />
    </>
  );
}
