import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AttachmentExtractorRegistry } from "./attachment.extractors";
import { OBJECT_STORAGE, sanitizeObjectKey, type ObjectStorageService } from "../storage/object-storage.types";
import { FeatureFlagService } from "../feature-flags/feature-flag.service";
import { SkillsRuntimeService } from "../skills-platform/skill-runtime.service";

const SKILLS_FILE_ROUTING_FLAG = "SKILLS_FILE_ROUTING_ENABLED";
const DOCUMENT_READER_SKILL_KEY = "document-reader";

export interface UploadedAttachmentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** How attachment files are stored: keeps the raw bytes in an in-memory/temp map keyed by a UUID. In
 *  production this can be swapped for S3/local-disk storage without touching callers. */
export interface AttachmentFileStore {
  save(buffer: Buffer): Promise<string>;
  read(storageKey: string): Promise<Buffer>;
}

@Injectable()
export class InMemoryAttachmentFileStore implements AttachmentFileStore {
  private readonly store = new Map<string, Buffer>();
  async save(buffer: Buffer): Promise<string> {
    const key = randomUUID();
    this.store.set(key, buffer);
    return key;
  }
  async read(storageKey: string): Promise<Buffer> {
    const buffer = this.store.get(storageKey);
    if (!buffer) throw new NotFoundException("ATTACHMENT_STORAGE_KEY_NOT_FOUND");
    return buffer;
  }
}

export interface ConversationAttachmentRecord {
  id: string;
  organizationId: string;
  pluginInstallationId: string;
  conversationId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  extractedText: string;
  createdAt: Date;
}

/** Uploads a conversation attachment, extracts its text (PDF/DOCX/TXT/JPG/PNG), persists the row, and
 *  returns it so the agent runtime can inject the extracted text into the next turn's context. */
@Injectable()
export class ConversationAttachmentService {
  private readonly logger = new Logger(ConversationAttachmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly extractors: AttachmentExtractorRegistry,
    private readonly store: InMemoryAttachmentFileStore,
    @Inject(OBJECT_STORAGE) @Optional() private readonly objectStorage?: ObjectStorageService,
    @Optional() private readonly featureFlags?: FeatureFlagService,
    @Optional() private readonly skillsRuntime?: SkillsRuntimeService
  ) {}

  async upload(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    createdByUserId: string | null,
    file?: UploadedAttachmentFile
  ): Promise<ConversationAttachmentRecord> {
    if (!file || !file.buffer?.length)
      throw new NotFoundException("ATTACHMENT_FILE_REQUIRED");

    const routed = await this.tryRouteThroughSkill(
      organizationId,
      pluginInstallationId,
      conversationId,
      createdByUserId,
      file
    );

    let extractedText: string;
    let objectStorageKey: string | null = routed?.objectStorageKey ?? null;

    if (routed) {
      extractedText = routed.text;
    } else {
      if (!this.extractors.supports(file.mimetype))
        throw new NotFoundException("ATTACHMENT_FILE_TYPE_UNSUPPORTED");
      const extracted = await this.extractors.extract(file.mimetype, file.buffer);
      extractedText = extracted.text;
    }

    if (!objectStorageKey) {
      objectStorageKey = await this.tryWriteObjectStorage(organizationId, conversationId, file);
    }

    const storageKey = await this.store.save(file.buffer);

    const row = await this.prisma.conversationAttachment.create({
      data: {
        organizationId,
        pluginInstallationId,
        conversationId,
        createdByUserId,
        originalFilename: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        objectStorageKey,
        extractedText: extractedText.slice(0, 50_000)
      }
    });
    this.logger.log({
      event: "CONVERSATION_ATTACHMENT_UPLOADED",
      attachmentId: row.id,
      conversationId,
      mimeType: file.mimetype,
      extractedCharacters: extractedText.length,
      viaSkill: routed !== null
    });
    return row;
  }

  /**
   * Sprint 6.1 — Phase 10 file routing. Behind SKILLS_FILE_ROUTING_ENABLED: if the employee has a
   * granted, installed skill that supports this MIME type (Document Reader today), route the file
   * through SkillsRuntimeService instead of the legacy AttachmentExtractorRegistry. Any failure —
   * flag off, no compatible/granted skill, or a runtime error — falls back to the pre-existing
   * extractor path untouched; this must never turn a previously-working upload into a failure.
   */
  private async tryRouteThroughSkill(
    organizationId: string,
    pluginInstallationId: string,
    conversationId: string,
    userId: string | null,
    file: UploadedAttachmentFile
  ): Promise<{ text: string; objectStorageKey: string | null } | null> {
    if (!this.skillsRuntime || !this.featureFlags) return null;
    try {
      const enabled = await this.featureFlags.isEnabled(SKILLS_FILE_ROUTING_FLAG, organizationId);
      if (!enabled) return null;

      const granted = await this.skillsRuntime.skillsForEmployee(organizationId, pluginInstallationId);
      const match = granted.find(
        (skill) => skill.skillKey === DOCUMENT_READER_SKILL_KEY && skill.supportedMimeTypes.includes(file.mimetype)
      );
      if (!match) return null;

      const objectStorageKey = await this.tryWriteObjectStorage(organizationId, conversationId, file);
      const result = await this.skillsRuntime.execute({
        skillKey: DOCUMENT_READER_SKILL_KEY,
        organizationId,
        pluginInstallationId,
        conversationId,
        ...(userId ? { userId } : {}),
        input: {
          fileName: file.originalname,
          mimeType: file.mimetype,
          ...(objectStorageKey ? { objectKey: objectStorageKey } : { content: file.buffer.toString("base64") })
        }
      });
      const data = result.data as { text?: unknown } | null;
      if (!data || typeof data.text !== "string") return null;
      return { text: data.text, objectStorageKey };
    } catch (error) {
      this.logger.warn({
        event: "ATTACHMENT_SKILL_ROUTING_FALLBACK",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }

  /** Best-effort durable object-storage write so skills (now or later) can read the original bytes.
   *  Never fails the upload — the in-memory store remains the record of truth for `storageKey`. */
  private async tryWriteObjectStorage(
    organizationId: string,
    conversationId: string,
    file: UploadedAttachmentFile
  ): Promise<string | null> {
    if (!this.objectStorage) return null;
    try {
      const key = sanitizeObjectKey(`conversation-attachments/${conversationId}/${randomUUID()}-${file.originalname}`);
      const meta = await this.objectStorage.putObject({
        organizationId,
        key,
        buffer: file.buffer,
        contentType: file.mimetype
      });
      return meta.key;
    } catch (error) {
      this.logger.warn({
        event: "ATTACHMENT_OBJECT_STORAGE_WRITE_FAILED",
        conversationId,
        error: error instanceof Error ? error.message : "unknown"
      });
      return null;
    }
  }

  async listForConversation(
    organizationId: string,
    conversationId: string
  ): Promise<ConversationAttachmentRecord[]> {
    return this.prisma.conversationAttachment.findMany({
      where: { organizationId, conversationId },
      orderBy: { createdAt: "asc" }
    });
  }

  /** Resolves the plugin installation id for a conversation, scoped to the organization. */
  async requirePluginInstallationId(organizationId: string, conversationId: string): Promise<string> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null }
    });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    return conversation.pluginInstallationId;
  }

  async get(
    organizationId: string,
    attachmentId: string
  ): Promise<ConversationAttachmentRecord> {
    const row = await this.prisma.conversationAttachment.findFirst({
      where: { id: attachmentId, organizationId }
    });
    if (!row) throw new NotFoundException("CONVERSATION_ATTACHMENT_NOT_FOUND");
    return row;
  }
}
