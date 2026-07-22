export const KNOWLEDGE_MIME_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown"
} as const;

export interface UploadedKnowledgeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ExtractedKnowledgeDocument {
  text: string;
  pages?: Array<{ pageNumber: number; text: string }>;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeTextExtractor {
  supports(mimeType: string): boolean;
  extract(buffer: Buffer): Promise<ExtractedKnowledgeDocument>;
}

export interface KnowledgeFileStorage {
  save(input: {
    organizationId: string;
    documentId: string;
    extension: string;
    buffer: Buffer;
  }): Promise<{ storageKey: string }>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}

export interface KnowledgeVirusScanner {
  scan(buffer: Buffer): Promise<void>;
}

export interface KnowledgeSource {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionTitle: string | null;
  score: number;
}
