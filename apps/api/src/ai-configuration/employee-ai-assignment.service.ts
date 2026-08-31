import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AiProfilePurpose } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import type {
  UpdateOrganizationAiDefaultsDto,
  UpsertEmployeeAiProfileAssignmentDto
} from "./ai-configuration.dto";

/** Manages which model profile a given employee (plugin installation) uses per purpose, and the
 *  organization-wide fallback profiles consulted when an employee has no assignment of its own —
 *  entirely database-driven, no employee-name conditions anywhere here or in the resolver. */
@Injectable()
export class EmployeeAiAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  async listForEmployee(organizationId: string, pluginInstallationId: string) {
    await this.requirePlugin(organizationId, pluginInstallationId);
    return this.prisma.employeeAiProfileAssignment.findMany({
      where: { organizationId, pluginInstallationId },
      include: { modelProfile: { select: { id: true, name: true, purpose: true, model: true } } },
      orderBy: { purpose: "asc" }
    });
  }

  async upsert(
    organizationId: string,
    pluginInstallationId: string,
    dto: UpsertEmployeeAiProfileAssignmentDto
  ) {
    await this.requirePlugin(organizationId, pluginInstallationId);
    const profile = await this.prisma.aiModelProfile.findFirst({
      where: { id: dto.modelProfileId, organizationId }
    });
    if (!profile) throw new BadRequestException("AI_MODEL_PROFILE_NOT_FOUND");
    return this.prisma.employeeAiProfileAssignment.upsert({
      where: {
        organizationId_pluginInstallationId_purpose: {
          organizationId,
          pluginInstallationId,
          purpose: dto.purpose
        }
      },
      create: {
        organizationId,
        pluginInstallationId,
        modelProfileId: dto.modelProfileId,
        purpose: dto.purpose
      },
      update: { modelProfileId: dto.modelProfileId }
    });
  }

  /** Removing an assignment is always safe — the resolver simply falls through to the next
   *  precedence step (employee DEFAULT, then organization defaults, then legacy config). No
   *  employee is ever left unable to resolve an AI configuration by removing an override. */
  async remove(organizationId: string, pluginInstallationId: string, purpose: AiProfilePurpose) {
    await this.requirePlugin(organizationId, pluginInstallationId);
    await this.prisma.employeeAiProfileAssignment.deleteMany({
      where: { organizationId, pluginInstallationId, purpose }
    });
  }

  async getOrganizationDefaults(organizationId: string) {
    const row = await this.prisma.organizationAiDefaults.findUnique({ where: { organizationId } });
    return (
      row ?? {
        organizationId,
        defaultProfileId: null,
        routingProfileId: null,
        reasoningProfileId: null,
        embeddingProfileId: null
      }
    );
  }

  /** Changing any of these fields immediately changes what every employee resolving that
   *  precedence step inherits, with no per-employee re-configuration — the key acceptance
   *  criterion for "organization default changes propagate without re-entering credentials". */
  async updateOrganizationDefaults(organizationId: string, dto: UpdateOrganizationAiDefaultsDto) {
    for (const id of [dto.defaultProfileId, dto.routingProfileId, dto.reasoningProfileId, dto.embeddingProfileId])
      if (id) await this.requireProfile(organizationId, id);
    return this.prisma.organizationAiDefaults.upsert({
      where: { organizationId },
      create: {
        organizationId,
        defaultProfileId: dto.defaultProfileId ?? null,
        routingProfileId: dto.routingProfileId ?? null,
        reasoningProfileId: dto.reasoningProfileId ?? null,
        embeddingProfileId: dto.embeddingProfileId ?? null
      },
      update: {
        ...(dto.defaultProfileId !== undefined ? { defaultProfileId: dto.defaultProfileId } : {}),
        ...(dto.routingProfileId !== undefined ? { routingProfileId: dto.routingProfileId } : {}),
        ...(dto.reasoningProfileId !== undefined ? { reasoningProfileId: dto.reasoningProfileId } : {}),
        ...(dto.embeddingProfileId !== undefined ? { embeddingProfileId: dto.embeddingProfileId } : {})
      }
    });
  }

  private async requirePlugin(organizationId: string, id: string) {
    const row = await this.prisma.plugin.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundException("PLUGIN_NOT_FOUND");
    return row;
  }

  private async requireProfile(organizationId: string, id: string) {
    const row = await this.prisma.aiModelProfile.findFirst({ where: { id, organizationId } });
    if (!row) throw new BadRequestException("AI_MODEL_PROFILE_NOT_FOUND");
    return row;
  }
}
