import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import type { KnowledgeCollectionCreateDto, KnowledgeCollectionUpdateDto } from "./knowledge.dto";

const collectionSelection = {
  id: true,
  pluginInstallationId: true,
  name: true,
  description: true,
  domain: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true
} as const;

/**
 * Owns the "AI Employee owns its own knowledge collections" boundary described in
 * docs/enterprise-knowledge.md — every read/write here is scoped to one (organizationId, employeeId)
 * pair, so a caller can never list, rename, or delete another employee's collection even if they know
 * its id.
 */
@Injectable()
export class KnowledgeCollectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEventLogger
  ) {}
  async create(
    organizationId: string,
    employeeId: string,
    requestId: string,
    userId: string,
    dto: KnowledgeCollectionCreateDto
  ) {
    await this.assertEmployee(organizationId, employeeId);
    const created = await this.prisma.knowledgeCollection.create({
      data: {
        organizationId,
        pluginInstallationId: employeeId,
        name: dto.name.trim(),
        ...(dto.description ? { description: dto.description.trim() } : {}),
        ...(dto.domain ? { domain: dto.domain.trim() } : {})
      },
      select: collectionSelection
    });
    this.audit.record("KNOWLEDGE_COLLECTION_CREATED", requestId, {
      organizationId,
      userId,
      targetId: created.id
    });
    return created;
  }
  async list(organizationId: string, employeeId: string) {
    await this.assertEmployee(organizationId, employeeId);
    return this.prisma.knowledgeCollection.findMany({
      where: { organizationId, pluginInstallationId: employeeId, deletedAt: null },
      select: { ...collectionSelection, _count: { select: { documents: true } } },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }]
    });
  }
  async update(organizationId: string, id: string, dto: KnowledgeCollectionUpdateDto) {
    await this.get(organizationId, id);
    return this.prisma.knowledgeCollection.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}),
        ...(dto.domain !== undefined ? { domain: dto.domain.trim() || null } : {})
      },
      select: collectionSelection
    });
  }
  async remove(
    organizationId: string,
    requestId: string,
    userId: string,
    id: string
  ): Promise<void> {
    const collection = await this.get(organizationId, id);
    if (collection.isDefault) throw new ConflictException("KNOWLEDGE_COLLECTION_IS_DEFAULT");
    const documentCount = await this.prisma.knowledgeDocument.count({
      where: { collectionId: id, deletedAt: null }
    });
    if (documentCount > 0) throw new ConflictException("KNOWLEDGE_COLLECTION_NOT_EMPTY");
    await this.prisma.knowledgeCollection.update({
      where: { id },
      data: { deletedAt: new Date() }
    });
    this.audit.record("KNOWLEDGE_COLLECTION_DELETED", requestId, {
      organizationId,
      userId,
      targetId: id
    });
  }
  async defaultCollection(organizationId: string, employeeId: string) {
    const existing = await this.prisma.knowledgeCollection.findFirst({
      where: { organizationId, pluginInstallationId: employeeId, isDefault: true, deletedAt: null }
    });
    if (existing) return existing;
    await this.assertEmployee(organizationId, employeeId);
    return this.prisma.knowledgeCollection.create({
      data: {
        organizationId,
        pluginInstallationId: employeeId,
        name: "General Knowledge",
        description: "Default knowledge collection for this AI Employee.",
        isDefault: true
      }
    });
  }
  async get(organizationId: string, id: string) {
    const collection = await this.prisma.knowledgeCollection.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: collectionSelection
    });
    if (!collection) throw new NotFoundException("KNOWLEDGE_COLLECTION_NOT_FOUND");
    return collection;
  }
  private async assertEmployee(organizationId: string, employeeId: string): Promise<void> {
    const exists = await this.prisma.plugin.count({
      where: { id: employeeId, organizationId, deletedAt: null }
    });
    if (!exists) throw new NotFoundException("PLUGIN_INSTALLATION_NOT_FOUND");
  }
}
