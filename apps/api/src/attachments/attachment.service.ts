import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AttachmentExtractorRegistry } from "./attachment.extractors";

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
    private readonly store: InMemoryAttachmentFileStore
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
    if (!this.extractors.supports(file.mimetype))
      throw new NotFoundException("ATTACHMENT_FILE_TYPE_UNSUPPORTED");

    const extracted = await this.extractors.extract(file.mimetype, file.buffer);
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
        extractedText: extracted.text.slice(0, 50_000)
      }
    });
    this.logger.log({
      event: "CONVERSATION_ATTACHMENT_UPLOADED",
      attachmentId: row.id,
      conversationId,
      mimeType: file.mimetype,
      extractedCharacters: extracted.text.length
    });
    return row;
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
