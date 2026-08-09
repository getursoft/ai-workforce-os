export const KNOWLEDGE_MIME_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip"
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
  collectionId: string;
  title: string;
  content: string;
  chunkIndex: number;
  pageNumber: number | null;
  heading: string | null;
  sectionTitle: string | null;
  isTable: boolean;
  /** Full ancestor chain from the chunk's metadata (document-root heading down to this chunk's own
   * heading, inclusive) — see `metadata.headingPath` in knowledge.chunking.ts. Used by the
   * response-generation layer (knowledge.prompt.ts) to detect sibling chunks under the same section
   * for section-summary answers, without re-deriving anything about ranking. */
  headingPath: string[];
  /** Final blended score (see knowledge.search.ts hybridScore) used for ranking and threshold cutoff. */
  score: number;
  /** Score breakdown, present only when retrieval debug logging is enabled (see KNOWLEDGE_RETRIEVAL_DEBUG_LOGGING). */
  scoreBreakdown?: {
    semantic: number;
    keywordOverlap: number;
    titleBoost: number;
    metadataBoost: number;
    exactPhraseBoost: number;
  };
}
