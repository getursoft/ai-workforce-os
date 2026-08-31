import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type { CreateAiModelProfileDto, UpdateAiModelProfileDto } from "./ai-configuration.dto";

/** Manages AiModelProfile rows — reusable (model + purpose + generation settings) configurations
 *  that reference an AiProviderConnection by id only. Never touches or reads credentials. */
@Injectable()
export class AiModelProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, purpose?: string) {
    return this.prisma.aiModelProfile.findMany({
      where: { organizationId, ...(purpose ? { purpose: purpose as never } : {}) },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { employeeAssignments: true } } }
    });
  }

  async get(organizationId: string, id: string) {
    return this.requireProfile(organizationId, id);
  }

  async create(organizationId: string, dto: CreateAiModelProfileDto) {
    await this.requireConnection(organizationId, dto.providerConnectionId);
    if (dto.isDefault)
      await this.prisma.aiModelProfile.updateMany({
        where: { organizationId, purpose: dto.purpose, isDefault: true },
        data: { isDefault: false }
      });
    return this.prisma.aiModelProfile.create({
      data: {
        organizationId,
        providerConnectionId: dto.providerConnectionId,
        name: dto.name.trim(),
        purpose: dto.purpose,
        model: dto.model?.trim() ?? null,
        embeddingModel: dto.embeddingModel?.trim() ?? null,
        temperature: dto.temperature ?? null,
        maxOutputTokens: dto.maxOutputTokens ?? null,
        timeoutMs: dto.timeoutMs ?? null,
        additionalSettingsJson: (dto.additionalSettingsJson ?? {}) as Prisma.InputJsonValue,
        isDefault: dto.isDefault ?? false,
        isActive: dto.isActive ?? true
      }
    });
  }

  async update(organizationId: string, id: string, dto: UpdateAiModelProfileDto) {
    const existing = await this.requireProfile(organizationId, id);
    if (dto.providerConnectionId) await this.requireConnection(organizationId, dto.providerConnectionId);
    const purpose = dto.purpose ?? existing.purpose;
    if (dto.isDefault)
      await this.prisma.aiModelProfile.updateMany({
        where: { organizationId, purpose, isDefault: true, id: { not: id } },
        data: { isDefault: false }
      });
    return this.prisma.aiModelProfile.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.providerConnectionId !== undefined ? { providerConnectionId: dto.providerConnectionId } : {}),
        ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
        ...(dto.model !== undefined ? { model: dto.model.trim() || null } : {}),
        ...(dto.embeddingModel !== undefined ? { embeddingModel: dto.embeddingModel.trim() || null } : {}),
        ...(dto.temperature !== undefined ? { temperature: dto.temperature } : {}),
        ...(dto.maxOutputTokens !== undefined ? { maxOutputTokens: dto.maxOutputTokens } : {}),
        ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
        ...(dto.additionalSettingsJson !== undefined
          ? { additionalSettingsJson: dto.additionalSettingsJson as Prisma.InputJsonValue }
          : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {})
      }
    });
  }

  /** Refuses deletion while any employee still has this profile assigned — the caller must
   *  reassign or remove those assignments first (Phase 28's "no silently unusable employee"
   *  rule). Disabling (isActive: false) is always allowed and is the safe alternative: the
   *  resolver treats an inactive profile as absent and falls through the precedence chain. */
  async delete(organizationId: string, id: string) {
    await this.requireProfile(organizationId, id);
    const dependentAssignments = await this.prisma.employeeAiProfileAssignment.count({
      where: { organizationId, modelProfileId: id }
    });
    if (dependentAssignments > 0) throw new ConflictException("AI_MODEL_PROFILE_HAS_ASSIGNMENTS");
    await this.prisma.aiModelProfile.delete({ where: { id } });
  }

  private async requireProfile(organizationId: string, id: string) {
    const row = await this.prisma.aiModelProfile.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException("AI_MODEL_PROFILE_NOT_FOUND");
    return row;
  }

  private async requireConnection(organizationId: string, id: string) {
    const row = await this.prisma.aiProviderConnection.findFirst({ where: { id, organizationId } });
    if (!row) throw new BadRequestException("AI_PROVIDER_CONNECTION_NOT_FOUND");
    return row;
  }
}
