"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Label,
  Skeleton
} from "../../components/ui";
import { AccessGate, Can } from "../admin/authorization";
import { useAuth } from "../auth/auth-provider";
import { createAgentApi, type AgentEmployee } from "../agents/agent-api";
import {
  createKnowledgeApi,
  type KnowledgeCollection,
  type KnowledgeDocument,
  type KnowledgeStatus
} from "./knowledge-api";

function useKnowledgeApi() {
  const { client } = useAuth();
  return useMemo(() => createKnowledgeApi(client), [client]);
}
function useAgentApi() {
  const { client } = useAuth();
  return useMemo(() => createAgentApi(client), [client]);
}
function statusTone(status: KnowledgeStatus) {
  if (status === "INDEXED") return "success" as const;
  if (status === "FAILED") return "danger" as const;
  return "warning" as const;
}

/** Every AI Employee owns its own knowledge — this selector is the scoping boundary the rest of the
 * page operates within, matching the backend's per-employee routes (see knowledge-api.ts). */
function EmployeeSelect({
  employees,
  value,
  onChange
}: {
  employees: AgentEmployee[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <>
      <Label htmlFor="knowledge-employee">AI Employee</Label>
      <select
        className="ui-input"
        id="knowledge-employee"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {employees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.displayName}
          </option>
        ))}
      </select>
    </>
  );
}

export function KnowledgePage() {
  const api = useKnowledgeApi(),
    agentApi = useAgentApi(),
    queryClient = useQueryClient(),
    fileInput = useRef<HTMLInputElement>(null),
    [employeeId, setEmployeeId] = useState(""),
    [collectionId, setCollectionId] = useState(""),
    [newCollectionName, setNewCollectionName] = useState(""),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [selected, setSelected] = useState<KnowledgeDocument | null>(null);
  const employees = useQuery({ queryKey: ["agents", "employees"], queryFn: agentApi.employees });
  useEffect(() => {
    if (!employeeId && employees.data?.length) setEmployeeId(employees.data[0]?.id ?? "");
  }, [employeeId, employees.data]);
  const collections = useQuery({
    queryKey: ["knowledge-collections", employeeId],
    queryFn: () => api.collections.list(employeeId),
    enabled: Boolean(employeeId)
  });
  useEffect(() => {
    if (collections.data?.length && !collections.data.some((item) => item.id === collectionId))
      setCollectionId(
        collections.data.find((item) => item.isDefault)?.id ?? collections.data[0]?.id ?? ""
      );
  }, [collectionId, collections.data]);
  const documents = useQuery({
    queryKey: ["knowledge", employeeId, search, status],
    queryFn: () => api.list(employeeId, { search, status }),
    enabled: Boolean(employeeId)
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["knowledge", employeeId] });
  const refreshCollections = () =>
    queryClient.invalidateQueries({ queryKey: ["knowledge-collections", employeeId] });
  const upload = useMutation({
    mutationFn: (file: File) => api.upload(employeeId, collectionId, file),
    onSuccess: () => {
      if (fileInput.current) fileInput.current.value = "";
      void refresh();
    }
  });
  const createCollection = useMutation({
    mutationFn: () => api.collections.create(employeeId, { name: newCollectionName }),
    onSuccess: () => {
      setNewCollectionName("");
      void refreshCollections();
    }
  });
  const reindex = useMutation({ mutationFn: api.reindex, onSuccess: refresh });
  const remove = useMutation({
    mutationFn: api.remove,
    onSuccess: () => {
      setSelected(null);
      void refresh();
    }
  });
  const submitUpload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (file && collectionId && !upload.isPending) upload.mutate(file);
  };
  const submitCollection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newCollectionName.trim() && !createCollection.isPending) createCollection.mutate();
  };
  return (
    <AccessGate permission="knowledge.read">
      <section className="admin-page">
        <header className="admin-page__header">
          <div>
            <h1>Knowledge Base</h1>
            <p>
              Each AI Employee owns its own knowledge collections — documents uploaded here are only
              ever retrieved by the employee selected below.
            </p>
          </div>
        </header>
        <div className="admin-toolbar">
          {employees.data?.length ? (
            <EmployeeSelect
              employees={employees.data}
              value={employeeId}
              onChange={setEmployeeId}
            />
          ) : null}
        </div>
        {!employeeId ? (
          <EmptyState
            title="No AI Employees"
            description="Install and enable an AI Employee before uploading knowledge."
          />
        ) : (
          <>
            <Card>
              <h2>Collections</h2>
              <p>
                A collection groups related documents for this employee (e.g. Visa Rules, Refund
                Rules).
              </p>
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Domain</th>
                      <th>Documents</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collections.data?.map((collection: KnowledgeCollection) => (
                      <tr key={collection.id}>
                        <td>
                          {collection.name} {collection.isDefault ? <Badge>Default</Badge> : null}
                        </td>
                        <td>{collection.domain ?? "—"}</td>
                        <td>{collection._count?.documents ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Can permission="knowledge.collection.manage">
                <form className="admin-form" onSubmit={submitCollection}>
                  <Label htmlFor="new-collection-name">New collection name</Label>
                  <Input
                    id="new-collection-name"
                    value={newCollectionName}
                    onChange={(event) => setNewCollectionName(event.target.value)}
                    placeholder="e.g. Visa Rules"
                  />
                  <Button
                    loading={createCollection.isPending}
                    disabled={createCollection.isPending}
                  >
                    Create collection
                  </Button>
                </form>
              </Can>
            </Card>
            <Can permission="knowledge.upload">
              <Card>
                <form className="admin-form" onSubmit={submitUpload}>
                  <Label htmlFor="knowledge-collection">Collection</Label>
                  <select
                    className="ui-input"
                    id="knowledge-collection"
                    value={collectionId}
                    onChange={(event) => setCollectionId(event.target.value)}
                  >
                    {collections.data?.map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name}
                      </option>
                    ))}
                  </select>
                  <Label htmlFor="knowledge-file">Upload document</Label>
                  <Input
                    ref={fileInput}
                    id="knowledge-file"
                    name="file"
                    type="file"
                    required
                    accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                  />
                  <small>PDF, DOCX, TXT, or Markdown. Maximum 10 MB by default.</small>
                  <Button loading={upload.isPending} disabled={upload.isPending || !collectionId}>
                    Upload and index
                  </Button>
                </form>
                {upload.isError ? (
                  <Alert tone="danger" title="Document upload failed">
                    The document could not be uploaded or indexed safely.
                  </Alert>
                ) : null}
                {upload.isSuccess ? (
                  <Alert tone="success" title="Document indexed">
                    The document is ready for this AI Employee's knowledge search.
                  </Alert>
                ) : null}
              </Card>
            </Can>
            <div className="admin-toolbar">
              <Label htmlFor="knowledge-search">Search</Label>
              <Input
                id="knowledge-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Title or filename"
              />
              <Label htmlFor="knowledge-status">Status</Label>
              <select
                className="ui-input"
                id="knowledge-status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">All statuses</option>
                {["UPLOADED", "PROCESSING", "INDEXED", "FAILED"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </div>
            {documents.isLoading ? (
              <Skeleton />
            ) : documents.isError ? (
              <Alert tone="danger" title="Unable to load knowledge documents" />
            ) : documents.data?.items.length ? (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Status</th>
                      <th>Chunks</th>
                      <th>Uploaded by</th>
                      <th>Uploaded</th>
                      <th>Indexed</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {documents.data.items.map((document) => (
                      <tr key={document.id}>
                        <td>
                          <Link href={`/knowledge/${document.id}`}>{document.title}</Link>
                          <small>{document.originalFilename}</small>
                        </td>
                        <td>
                          <Badge tone={statusTone(document.status)}>{document.status}</Badge>
                        </td>
                        <td>{document.chunkCount}</td>
                        <td>
                          {document.uploadedBy.firstName} {document.uploadedBy.lastName}
                        </td>
                        <td>{new Date(document.createdAt).toLocaleString()}</td>
                        <td>
                          {document.indexedAt ? new Date(document.indexedAt).toLocaleString() : "—"}
                        </td>
                        <td>
                          <Link href={`/knowledge/${document.id}`}>View</Link>
                          <Can permission="knowledge.reindex">
                            <Button
                              variant="secondary"
                              loading={reindex.isPending && reindex.variables === document.id}
                              onClick={() => reindex.mutate(document.id)}
                            >
                              Re-index
                            </Button>
                          </Can>
                          <Can permission="knowledge.delete">
                            <Button variant="danger" onClick={() => setSelected(document)}>
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
                title="No knowledge documents"
                description="Upload a document to ground this AI Employee's answers."
              />
            )}
          </>
        )}
        <Dialog
          open={Boolean(selected)}
          title="Delete knowledge document?"
          description="Deleted documents immediately stop being used by this AI employee."
          destructive
          confirmLabel="Delete document"
          onCancel={() => setSelected(null)}
          onConfirm={() => (selected ? remove.mutateAsync(selected.id) : undefined)}
        />
      </section>
    </AccessGate>
  );
}

export function KnowledgeDetailPage({ id }: { id: string }) {
  const api = useKnowledgeApi(),
    router = useRouter(),
    queryClient = useQueryClient(),
    [confirmDelete, setConfirmDelete] = useState(false),
    document = useQuery({ queryKey: ["knowledge", id], queryFn: () => api.get(id) }),
    reindex = useMutation({
      mutationFn: () => api.reindex(id),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge", id] })
    }),
    remove = useMutation({
      mutationFn: () => api.remove(id),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["knowledge"] });
        router.replace("/knowledge");
      }
    });
  return (
    <AccessGate permission="knowledge.read">
      <section className="admin-page">
        {document.isLoading ? (
          <Skeleton />
        ) : document.isError || !document.data ? (
          <Alert tone="danger" title="Unable to load knowledge document" />
        ) : (
          <>
            <header className="admin-page__header">
              <div>
                <h1>{document.data.title}</h1>
                <p>{document.data.originalFilename}</p>
              </div>
              <Can permission="knowledge.reindex">
                <Button loading={reindex.isPending} onClick={() => reindex.mutate()}>
                  Re-index
                </Button>
              </Can>
              <Can permission="knowledge.delete">
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              </Can>
            </header>
            <Card>
              <dl className="admin-details">
                <dt>Status</dt>
                <dd>
                  <Badge tone={statusTone(document.data.status)}>{document.data.status}</Badge>
                </dd>
                <dt>Type</dt>
                <dd>{document.data.mimeType}</dd>
                <dt>Size</dt>
                <dd>{Math.ceil(document.data.fileSizeBytes / 1024)} KB</dd>
                <dt>Chunks</dt>
                <dd>{document.data.chunkCount}</dd>
                <dt>Indexed</dt>
                <dd>
                  {document.data.indexedAt
                    ? new Date(document.data.indexedAt).toLocaleString()
                    : "—"}
                </dd>
              </dl>
              {document.data.processingError ? (
                <Alert tone="danger" title="Processing failed">
                  {document.data.processingError}
                </Alert>
              ) : null}
            </Card>
            <h2>Chunk previews</h2>
            {document.data.chunks.length ? (
              document.data.chunks.map((chunk) => (
                <Card key={chunk.id}>
                  <Badge>Chunk {chunk.chunkIndex + 1}</Badge>{" "}
                  {chunk.pageNumber ? <Badge>Page {chunk.pageNumber}</Badge> : null}
                  {chunk.heading ? <Badge>{chunk.heading}</Badge> : null}
                  {chunk.isTable ? <Badge>Table</Badge> : null}
                  <p>{chunk.content}</p>
                </Card>
              ))
            ) : (
              <EmptyState
                title="No indexed chunks"
                description="Re-index this document after resolving its processing error."
              />
            )}
            <Dialog
              open={confirmDelete}
              title="Delete knowledge document?"
              description="This document will immediately stop being used by AI employees."
              destructive
              confirmLabel="Delete document"
              onCancel={() => setConfirmDelete(false)}
              onConfirm={() => remove.mutateAsync()}
            />
          </>
        )}
      </section>
    </AccessGate>
  );
}
