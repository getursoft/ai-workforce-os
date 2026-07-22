import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { KnowledgeDocumentStatus, Prisma } from "@prisma/client";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { KnowledgeChunkingService } from "./knowledge.chunking";
import type { KnowledgePageDto } from "./knowledge.dto";
import { KnowledgeEmbeddingService } from "./knowledge.embedding";
import { KnowledgeExtractorRegistry } from "./knowledge.extractors";
import type {
  KnowledgeFileStorage,
  KnowledgeVirusScanner,
  UploadedKnowledgeFile
} from "./knowledge.types";
import { KNOWLEDGE_MIME_TYPES } from "./knowledge.types";

@Injectable()
export class KnowledgeIndexingService {
  private readonly logger = new Logger(KnowledgeIndexingService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: KnowledgeFileStorage,
    private readonly extractors: KnowledgeExtractorRegistry,
    private readonly chunker: KnowledgeChunkingService,
    private readonly embeddings: KnowledgeEmbeddingService,
    private readonly audit: AuditEventLogger
  ) {}
  async index(organizationId: string, documentId: string, reindex = false) {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, organizationId, deletedAt: null }
    });
    if (!document) throw new NotFoundException("KNOWLEDGE_DOCUMENT_NOT_FOUND");
    if (!document.storageKey) throw new BadRequestException("KNOWLEDGE_FILE_INVALID");
    const started = Date.now();
    await this.prisma.knowledgeDocument.update({
      where: { id: document.id },
      data: { status: KnowledgeDocumentStatus.PROCESSING, processingError: null }
    });
    try {
      const buffer = await this.storage.read(document.storageKey);
      const extracted = await this.extractors.extract(document.mimeType, buffer);
      const chunks = this.chunker.chunk(extracted);
      if (!chunks.length) throw new Error("KNOWLEDGE_TEXT_NOT_EXTRACTABLE");
      const embedded: Array<{ vector: number[]; model: string }> = [];
      for (let start = 0; start < chunks.length; start += 32) {
        const batch = chunks.slice(start, start + 32);
        const result = await this.embeddings.embed(
          organizationId,
          batch.map((chunk) => chunk.content)
        );
        for (const vector of result.vectors) embedded.push({ vector, model: result.model });
      }
      if (embedded.length !== chunks.length) throw new Error("EMBEDDING_PROVIDER_RESPONSE_INVALID");
      await this.prisma.$transaction(async (transaction) => {
        await transaction.knowledgeChunk.deleteMany({
          where: { documentId: document.id, organizationId }
        });
        await transaction.knowledgeChunk.createMany({
          data: chunks.map((chunk, index) => {
            const embedding = embedded[index];
            if (!embedding) throw new Error("EMBEDDING_PROVIDER_RESPONSE_INVALID");
            return {
              organizationId,
              documentId: document.id,
              chunkIndex: index,
              content: chunk.content,
              tokenCount: chunk.tokenCount,
              ...(chunk.pageNumber ? { pageNumber: chunk.pageNumber } : {}),
              ...(chunk.sectionTitle ? { sectionTitle: chunk.sectionTitle } : {}),
              embeddingJson: embedding.vector as Prisma.InputJsonValue,
              embeddingModel: embedding.model
            };
          })
        });
        await transaction.knowledgeDocument.update({
          where: { id: document.id },
          data: {
            extractedText: extracted.text,
            status: KnowledgeDocumentStatus.INDEXED,
            chunkCount: chunks.length,
            processingError: null,
            indexedAt: new Date()
          }
        });
      });
      this.logger.log({
        event: "KNOWLEDGE_DOCUMENT_INDEXED",
        organizationId,
        documentId,
        chunkCount: chunks.length,
        durationMs: Date.now() - started
      });
      this.audit.record(
        reindex ? "KNOWLEDGE_DOCUMENT_REINDEXED" : "KNOWLEDGE_DOCUMENT_INDEXED",
        `knowledge-${documentId}`,
        { organizationId, targetId: documentId }
      );
      return this.get(organizationId, documentId);
    } catch (error) {
      const code = safeProcessingCode(error);
      await this.prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: {
          status: KnowledgeDocumentStatus.FAILED,
          processingError: processingMessage(code)
        }
      });
      this.logger.warn({
        event: "KNOWLEDGE_DOCUMENT_INDEX_FAILED",
        organizationId,
        documentId,
        code,
        durationMs: Date.now() - started
      });
      this.audit.record("KNOWLEDGE_DOCUMENT_INDEX_FAILED", `knowledge-${documentId}`, {
        organizationId,
        targetId: documentId
      });
      throw new BadRequestException(code);
    }
  }
  private get(organizationId: string, id: string) {
    return this.prisma.knowledgeDocument.findFirstOrThrow({
      where: { id, organizationId, deletedAt: null },
      select: documentSelection
    });
  }
}

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: KnowledgeFileStorage,
    private readonly scanner: KnowledgeVirusScanner,
    private readonly indexing: KnowledgeIndexingService,
    private readonly audit: AuditEventLogger,
    private readonly maxFileSizeBytes: number
  ) {}
  async upload(
    organizationId: string,
    userId: string,
    requestId: string,
    file?: UploadedKnowledgeFile
  ) {
    const validated = this.validate(file);
    await this.scanner.scan(validated.buffer);
    const id = randomUUID();
    const created = await this.prisma.knowledgeDocument.create({
      data: {
        id,
        organizationId,
        title: titleFromFilename(validated.originalname),
        originalFilename: safeFilename(validated.originalname),
        mimeType: validated.mimetype,
        fileSizeBytes: validated.size,
        uploadedByUserId: userId
      }
    });
    try {
      const saved = await this.storage.save({
        organizationId,
        documentId: id,
        extension: extname(validated.originalname).toLowerCase(),
        buffer: validated.buffer
      });
      await this.prisma.knowledgeDocument.update({
        where: { id },
        data: { storageKey: saved.storageKey }
      });
      this.audit.record("KNOWLEDGE_DOCUMENT_UPLOADED", requestId, {
        organizationId,
        userId,
        targetId: id
      });
      return await this.indexing.index(organizationId, id);
    } catch (error) {
      if (!created.storageKey)
        await this.prisma.knowledgeDocument.update({
          where: { id },
          data: {
            status: KnowledgeDocumentStatus.FAILED,
            processingError: "The document could not be stored or indexed."
          }
        });
      throw error;
    }
  }
  async list(organizationId: string, query: KnowledgePageDto) {
    const where: Prisma.KnowledgeDocumentWhereInput = {
      organizationId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: "insensitive" } },
              { originalFilename: { contains: query.search, mode: "insensitive" } }
            ]
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.knowledgeDocument.findMany({
        where,
        select: documentSelection,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.knowledgeDocument.count({ where })
    ]);
    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        pages: Math.ceil(total / query.pageSize)
      }
    };
  }
  async get(organizationId: string, id: string, page = 1, pageSize = 20) {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: documentSelection
    });
    if (!document) throw new NotFoundException("KNOWLEDGE_DOCUMENT_NOT_FOUND");
    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: { documentId: id, organizationId },
      select: {
        id: true,
        chunkIndex: true,
        content: true,
        tokenCount: true,
        pageNumber: true,
        sectionTitle: true
      },
      orderBy: { chunkIndex: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize
    });
    return { ...document, chunks };
  }
  reindex(organizationId: string, id: string) {
    return this.indexing.index(organizationId, id, true);
  }
  async remove(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string
  ): Promise<void> {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!document) throw new NotFoundException("KNOWLEDGE_DOCUMENT_NOT_FOUND");
    await this.prisma.$transaction([
      this.prisma.knowledgeChunk.deleteMany({ where: { documentId: id, organizationId } }),
      this.prisma.knowledgeDocument.update({
        where: { id },
        data: { deletedAt: new Date(), chunkCount: 0 }
      })
    ]);
    if (document.storageKey) await this.storage.delete(document.storageKey);
    this.audit.record("KNOWLEDGE_DOCUMENT_DELETED", requestId, {
      organizationId,
      userId,
      targetId: id
    });
  }
  private validate(file?: UploadedKnowledgeFile): UploadedKnowledgeFile {
    if (!file) throw new BadRequestException("KNOWLEDGE_FILE_REQUIRED");
    if (!file.size || !file.buffer.length) throw new BadRequestException("KNOWLEDGE_FILE_INVALID");
    if (file.size > this.maxFileSizeBytes)
      throw new BadRequestException("KNOWLEDGE_FILE_TOO_LARGE");
    const extension = extname(file.originalname).toLowerCase() as keyof typeof KNOWLEDGE_MIME_TYPES;
    if (!Object.hasOwn(KNOWLEDGE_MIME_TYPES, extension))
      throw new BadRequestException("KNOWLEDGE_FILE_TYPE_UNSUPPORTED");
    const expected = KNOWLEDGE_MIME_TYPES[extension];
    if (file.mimetype !== expected && !(extension === ".md" && file.mimetype === "text/plain"))
      throw new BadRequestException("KNOWLEDGE_FILE_TYPE_UNSUPPORTED");
    return { ...file, originalname: safeFilename(file.originalname), mimetype: expected };
  }
}

const documentSelection = {
  id: true,
  title: true,
  originalFilename: true,
  mimeType: true,
  fileSizeBytes: true,
  status: true,
  processingError: true,
  chunkCount: true,
  indexedAt: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: { select: { id: true, firstName: true, lastName: true } }
} satisfies Prisma.KnowledgeDocumentSelect;

function safeFilename(value: string): string {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "document";
  return basename.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 255) || "document";
}
function titleFromFilename(value: string): string {
  return (
    safeFilename(value)
      .replace(/\.[^.]+$/, "")
      .trim()
      .slice(0, 200) || "Knowledge document"
  );
}
function safeProcessingCode(error: unknown): string {
  const code =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "KNOWLEDGE_INDEXING_FAILED";
  return [
    "KNOWLEDGE_TEXT_NOT_EXTRACTABLE",
    "EMBEDDING_PROVIDER_NOT_CONFIGURED",
    "EMBEDDING_PROVIDER_REQUEST_FAILED",
    "EMBEDDING_PROVIDER_RESPONSE_INVALID"
  ].includes(code)
    ? code
    : "KNOWLEDGE_INDEXING_FAILED";
}
function processingMessage(code: string): string {
  if (code === "KNOWLEDGE_TEXT_NOT_EXTRACTABLE")
    return "No extractable text was found. Scanned documents require OCR, which is not available.";
  if (code === "EMBEDDING_PROVIDER_NOT_CONFIGURED")
    return "An embedding provider is not configured.";
  return "The document could not be indexed safely.";
}
