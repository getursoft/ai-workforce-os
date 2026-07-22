import type { ApiClient } from "../../lib/api-client";

export type KnowledgeStatus = "UPLOADED" | "PROCESSING" | "INDEXED" | "FAILED";
export interface KnowledgeDocument {
  id: string;
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
  sectionTitle: string | null;
}
export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  chunks: KnowledgeChunkPreview[];
}
export interface KnowledgeSource {
  documentId: string;
  title: string;
  pageNumber: number | null;
  chunkIndex: number;
  score: number;
}
type Page<T> = {
  items: T[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
};

export function createKnowledgeApi(client: ApiClient) {
  return {
    list: (params: { page?: number; search?: string; status?: string } = {}) => {
      const query = new URLSearchParams({
        page: String(params.page ?? 1),
        pageSize: "20",
        ...(params.search ? { search: params.search } : {}),
        ...(params.status ? { status: params.status } : {})
      });
      return client.request<Page<KnowledgeDocument>>(`/knowledge/documents?${query}`);
    },
    get: (id: string) => client.request<KnowledgeDocumentDetail>(`/knowledge/documents/${id}`),
    upload: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return client.request<KnowledgeDocument>("/knowledge/documents", {
        method: "POST",
        body
      });
    },
    reindex: (id: string) =>
      client.request<KnowledgeDocument>(`/knowledge/documents/${id}/reindex`, {
        method: "POST"
      }),
    remove: (id: string) =>
      client.request<undefined>(`/knowledge/documents/${id}`, { method: "DELETE" })
  };
}
