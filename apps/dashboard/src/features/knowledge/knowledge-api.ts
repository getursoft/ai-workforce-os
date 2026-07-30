import type { ApiClient } from "../../lib/api-client";

export type KnowledgeStatus = "UPLOADED" | "PROCESSING" | "INDEXED" | "FAILED";
export interface KnowledgeDocument {
  id: string;
  collectionId: string;
  title: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  status: KnowledgeStatus;
  processingError: string | null;
  chunkCount: number;
  indexedAt: string | null;
  createdAt: string;
  updatedAt: string;
  uploadedBy: { id: string; firstName: string; lastName: string | null };
}
export interface KnowledgeChunkPreview {
  id: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  pageNumber: number | null;
  heading: string | null;
  sectionTitle: string | null;
  isTable: boolean;
}
export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  chunks: KnowledgeChunkPreview[];
}
export interface KnowledgeSource {
  documentId: string;
  collectionId: string;
  title: string;
  pageNumber: number | null;
  heading: string | null;
  sectionTitle: string | null;
  isTable: boolean;
  chunkIndex: number;
  score: number;
}
export interface KnowledgeCollection {
  id: string;
  pluginInstallationId: string;
  name: string;
  description: string | null;
  domain: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { documents: number };
}
type Page<T> = {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
};

/** Every knowledge read/write is nested under an AI Employee id — see docs/enterprise-knowledge.md
 * "Knowledge hierarchy". There is no organization-wide knowledge view any more: the dashboard must
 * always know which employee's knowledge it is showing. */
export function createKnowledgeApi(client: ApiClient) {
  return {
    collections: {
      list: (employeeId: string) =>
        client.request<KnowledgeCollection[]>(`/knowledge/employees/${employeeId}/collections`),
      create: (
        employeeId: string,
        input: { name: string; description?: string; domain?: string }
      ) =>
        client.request<KnowledgeCollection>(`/knowledge/employees/${employeeId}/collections`, {
          method: "POST",
          body: JSON.stringify(input)
        }),
      update: (id: string, input: { name?: string; description?: string; domain?: string }) =>
        client.request<KnowledgeCollection>(`/knowledge/collections/${id}`, {
          method: "PATCH",
          body: JSON.stringify(input)
        }),
      remove: (id: string) =>
        client.request<undefined>(`/knowledge/collections/${id}`, { method: "DELETE" })
    },
    list: (
      employeeId: string,
      params: { page?: number; search?: string; status?: string; collectionId?: string } = {}
    ) => {
      const query = new URLSearchParams({
        page: String(params.page ?? 1),
        pageSize: "20",
        ...(params.search ? { search: params.search } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.collectionId ? { collectionId: params.collectionId } : {})
      });
      return client.request<Page<KnowledgeDocument>>(
        `/knowledge/employees/${employeeId}/documents?${query}`
      );
    },
    get: (id: string) => client.request<KnowledgeDocumentDetail>(`/knowledge/documents/${id}`),
    upload: (employeeId: string, collectionId: string, file: File) => {
      const body = new FormData();
      body.append("file", file);
      return client.request<KnowledgeDocument>(
        `/knowledge/employees/${employeeId}/collections/${collectionId}/documents`,
        { method: "POST", body }
      );
    },
    reindex: (id: string) =>
      client.request<KnowledgeDocument>(`/knowledge/documents/${id}/reindex`, {
        method: "POST"
      }),
    remove: (id: string) =>
      client.request<undefined>(`/knowledge/documents/${id}`, { method: "DELETE" })
  };
}
