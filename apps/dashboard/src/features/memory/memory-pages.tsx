"use client";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  Label,
  Skeleton
} from "../../components/ui";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import {
  createMemoryApi,
  type MemoryImportance,
  type MemoryRecord,
  type MemoryScope,
  type MemorySource
} from "./memory-api";

function useMemoryApi() {
  const { client } = useAuth();
  return useMemo(() => createMemoryApi(client), [client]);
}

const SCOPES: readonly MemoryScope[] = ["USER", "ORGANIZATION", "EMPLOYEE", "CONVERSATION"];
const IMPORTANCES: readonly MemoryImportance[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function importanceTone(importance: MemoryImportance) {
  if (importance === "CRITICAL" || importance === "HIGH") return "success" as const;
  if (importance === "MEDIUM") return "warning" as const;
  return "neutral" as const;
}

function formatValue(record: MemoryRecord): string {
  const raw = record.value;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean")
    return String(raw);
  if (raw && typeof raw === "object" && "value" in raw) return String(raw.value);
  return JSON.stringify(raw);
}

function scopeLabel(scope: MemoryScope): string {
  if (scope === "USER") return "User Memory";
  if (scope === "ORGANIZATION") return "Organization Memory";
  if (scope === "EMPLOYEE") return "Employee Memory";
  if (scope === "CONVERSATION") return "Conversation Memory";
  return scope;
}

export { formatValue, scopeLabel };

/** The four memory-scope tabs — the scoping boundary the whole page operates within. */
function ScopeTabs({ value, onChange }: { value: MemoryScope; onChange: (scope: MemoryScope) => void }) {
  return (
    <div className="admin-tabs" role="tablist">
      {SCOPES.map((scope) => (
        <button
          key={scope}
          role="tab"
          aria-selected={scope === value}
          className={`admin-tabs__tab ${scope === value ? "admin-tabs__tab--active" : ""}`}
          onClick={() => onChange(scope)}
        >
          {scopeLabel(scope)}
        </button>
      ))}
    </div>
  );
}

export function MemoryPage() {
  const api = useMemoryApi(),
    queryClient = useQueryClient(),
    [tab, setTab] = useState<MemoryScope>("USER"),
    [search, setSearch] = useState(""),
    [importance, setImportance] = useState(""),
    [source, setSource] = useState(""),
    [selected, setSelected] = useState<MemoryRecord | null>(null),
    [newKey, setNewKey] = useState(""),
    [newValue, setNewValue] = useState(""),
    [newCategory, setNewCategory] = useState(""),
    [summarizeId, setSummarizeId] = useState(""),
    [auditOpen, setAuditOpen] = useState(false);

  const memories = useQuery({
    queryKey: ["memory", tab, search, importance, source],
    queryFn: () =>
      api.list(
        {
          scope: tab,
          ...(search ? { search } : {}),
          ...(importance ? { importance: importance as MemoryImportance } : {}),
          ...(source ? { source: source as MemorySource } : {})
        },
        1,
        50
      )
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["memory"] });

  const create = useMutation({
    mutationFn: () =>
      api.create({
        scope: tab,
        key: newKey.trim(),
        value: { value: newValue.trim() },
        ...(newCategory.trim() ? { category: newCategory.trim() } : {}),
        ...(tab === "USER" ? { importance: "HIGH" } : {}),
        searchableText: newValue.trim()
      }),
    onSuccess: () => {
      setNewKey("");
      setNewValue("");
      setNewCategory("");
      void refresh();
    }
  });

  const update = useMutation({
    mutationFn: (record: MemoryRecord) =>
      api.update(record.id, {
        value: record.value,
        importance: record.importance,
        ...(record.category ? { category: record.category } : {})
      }),
    onSuccess: () => {
      setSelected(null);
      void refresh();
    }
  });

  const remove = useMutation({
    mutationFn: api.remove,
    onSuccess: () => {
      setSelected(null);
      void refresh();
    }
  });

  const forget = useMutation({
    mutationFn: () => api.forget({ scope: tab }),
    onSuccess: () => void refresh()
  });

  const expire = useMutation({ mutationFn: () => api.expire(tab), onSuccess: () => void refresh() });

  const summarize = useMutation({
    mutationFn: () => api.summarize(summarizeId.trim()),
    onSuccess: () => {
      setSummarizeId("");
      void refresh();
    }
  });

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newKey.trim() && newValue.trim() && !create.isPending) create.mutate();
  };

  const toggleImportant = (record: MemoryRecord) => {
    update.mutate({ ...record, importance: record.importance === "HIGH" ? "MEDIUM" : "HIGH" });
  };

  return (
    <AccessGate permission="agents.memory.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Memory</h1>
            <p>
              Persistent memory is a platform capability every AI Employee shares. Facts users state —
              "I prefer vegetarian food", "my preferred airline is Emirates" — are remembered
              automatically and injected into every conversation.
            </p>
          </div>
          <Can permission="agents.memory.write">
            <Button variant="secondary" onClick={() => setAuditOpen(true)}>
              Audit trail
            </Button>
            <Button variant="secondary" loading={expire.isPending} onClick={() => expire.mutate()}>
              Run expiry
            </Button>
          </Can>
        </header>

        <ScopeTabs value={tab} onChange={setTab} />

        <div className="admin-toolbar">
          <Label htmlFor="memory-search">Search</Label>
          <Input
            id="memory-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Key or value"
          />
          <Label htmlFor="memory-importance">Importance</Label>
          <select
            className="ui-input"
            id="memory-importance"
            value={importance}
            onChange={(event) => setImportance(event.target.value)}
          >
            <option value="">All</option>
            {IMPORTANCES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <Label htmlFor="memory-source">Source</Label>
          <select
            className="ui-input"
            id="memory-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">All</option>
            {["CONVERSATION", "DASHBOARD", "TOOL", "SYSTEM", "RULE_EXTRACTION", "LLM_EXTRACTION", "IMPORT"].map(
              (value) => (
                <option key={value}>{value}</option>
              )
            )}
          </select>
        </div>

        <Can permission="agents.memory.write">
          <form className="admin-form" onSubmit={submitCreate}>
            <Label htmlFor="memory-key">Key</Label>
            <Input
              id="memory-key"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              placeholder="e.g. preferred.airline"
            />
            <Label htmlFor="memory-value">Value</Label>
            <Input
              id="memory-value"
              value={newValue}
              onChange={(event) => setNewValue(event.target.value)}
              placeholder="e.g. Emirates"
            />
            <Label htmlFor="memory-category">Category (optional)</Label>
            <Input
              id="memory-category"
              value={newCategory}
              onChange={(event) => setNewCategory(event.target.value)}
              placeholder="e.g. PREFERENCE"
            />
            <Button loading={create.isPending} disabled={create.isPending}>
              Add memory
            </Button>
          </form>
          {create.isError ? (
            <Alert tone="danger" title="Could not save memory">
              Check that the employee/conversation references are valid for this organization.
            </Alert>
          ) : null}
        </Can>

        {memories.isLoading ? (
          <Skeleton />
        ) : memories.isError ? (
          <Alert tone="danger" title="Unable to load memories" />
        ) : memories.data?.items.length ? (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Category</th>
                  <th>Importance</th>
                  <th>Source</th>
                  <th>Confidence</th>
                  <th>Expires</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {memories.data.items.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <strong>{record.key}</strong>
                      {record.metadata?.sensitive ? <Badge>sensitive</Badge> : null}
                    </td>
                    <td>{formatValue(record)}</td>
                    <td>{record.category}</td>
                    <td>
                      <Badge tone={importanceTone(record.importance)}>{record.importance}</Badge>
                    </td>
                    <td>{record.source}</td>
                    <td>{Number(record.confidence).toFixed(2)}</td>
                    <td>{record.expiresAt ? new Date(record.expiresAt).toLocaleDateString() : "never"}</td>
                    <td>{new Date(record.updatedAt).toLocaleString()}</td>
                    <td>
                      <Can permission="agents.memory.write">
                        <Button variant="secondary" onClick={() => toggleImportant(record)}>
                          Toggle importance
                        </Button>
                        <Button variant="danger" onClick={() => setSelected(record)}>
                          Delete
                        </Button>
                      </Can>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No memories"
            description="Conversations that state a preference will be remembered here automatically. You can also add one manually."
          />
        )}

        <Can permission="agents.memory.write">
          <div className="admin-section-header">
            <div>
              <h2>Summarize conversation</h2>
              <p>
                Collapse a long conversation into a rolling summary so prompts never suffer token
                explosion. Runs automatically every ~20 turns; you can trigger it here.
              </p>
            </div>
          </div>
          <form
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (summarizeId.trim() && !summarize.isPending) summarize.mutate();
            }}
          >
            <Label htmlFor="memory-summarize">Conversation ID</Label>
            <Input
              id="memory-summarize"
              value={summarizeId}
              onChange={(event) => setSummarizeId(event.target.value)}
              placeholder="conversation uuid"
            />
            <Button loading={summarize.isPending} disabled={summarize.isPending}>
              Summarize
            </Button>
          </form>
          {summarize.isSuccess ? (
            <Alert tone="success" title="Conversation summarized">
              {summarize.data.summarizedMessageCount} messages covered.
            </Alert>
          ) : null}
        </Can>

        <Can permission="agents.memory.write">
          <div className="admin-toolbar">
            <Button variant="danger" loading={forget.isPending} onClick={() => forget.mutate()}>
              Forget all {scopeLabel(tab).toLowerCase()}
            </Button>
          </div>
        </Can>

        <Dialog
          open={Boolean(selected)}
          title="Delete memory?"
          description="The memory will be soft-deleted and stop being injected into conversations."
          destructive
          confirmLabel="Delete memory"
          onCancel={() => setSelected(null)}
          onConfirm={() => (selected ? remove.mutateAsync(selected.id) : undefined)}
        />

        <AuditDialog open={auditOpen} onClose={() => setAuditOpen(false)} />
      </section>
    </AccessGate>
  );
}

function AuditDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useMemoryApi();
  const events = useQuery({
    queryKey: ["memory", "audit"],
    queryFn: () => api.audit(1),
    enabled: open
  });
  return (
    <Dialog
      open={open}
      title="Memory audit trail"
      description="Every memory operation is recorded with the actor, action, and target."
      confirmLabel="Close"
      onCancel={onClose}
      onConfirm={onClose}
    >
      {events.isLoading ? (
        <Skeleton />
      ) : events.data?.items.length ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Scope</th>
                <th>Key</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {events.data.items.map((event) => (
                <tr key={event.id}>
                  <td>{event.action}</td>
                  <td>{event.scope}</td>
                  <td>{event.key}</td>
                  <td>{new Date(event.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No audit events yet" description="Memory operations will appear here." />
      )}
    </Dialog>
  );
}
