import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { Prisma, TeamStatus, type TeamMemberRole } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}
  async list(
    org: string,
    q: {
      page: number;
      pageSize: number;
      search?: string;
      status?: TeamStatus;
      managerId?: string;
      parentTeamId?: string;
    }
  ) {
    const where: Prisma.TeamWhereInput = {
      organizationId: org,
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.managerId ? { managerId: q.managerId } : {}),
      ...(q.parentTeamId ? { parentTeamId: q.parentTeamId } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: "insensitive" } },
              { description: { contains: q.search, mode: "insensitive" } }
            ]
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.team.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { name: "asc" },
        include: {
          manager: { select: { id: true, firstName: true, lastName: true, email: true } },
          parentTeam: { select: { id: true, name: true } },
          _count: { select: { members: true, childTeams: true } }
        }
      }),
      this.prisma.team.count({ where })
    ]);
    return {
      items,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        pages: Math.ceil(total / q.pageSize)
      }
    };
  }
  async get(org: string, id: string) {
    const team = await this.prisma.team.findFirst({
      where: { id, organizationId: org, deletedAt: null },
      include: {
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
        parentTeam: { select: { id: true, name: true } },
        childTeams: { where: { deletedAt: null }, select: { id: true, name: true, status: true } },
        _count: { select: { members: true } }
      }
    });
    if (!team) throw new NotFoundException("Team not found");
    return team;
  }
  async create(
    org: string,
    input: { name: string; description?: string; managerId?: string; parentTeamId?: string }
  ) {
    await this.validateRelations(org, input.managerId, input.parentTeamId);
    const slug = await this.uniqueSlug(org, input.name);
    return this.prisma.team.create({
      data: {
        organizationId: org,
        name: input.name.trim(),
        slug,
        description: input.description?.trim() ?? null,
        managerId: input.managerId ?? null,
        parentTeamId: input.parentTeamId ?? null
      }
    });
  }
  async update(
    org: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      managerId?: string | null;
      parentTeamId?: string | null;
      status?: TeamStatus;
    }
  ) {
    await this.get(org, id);
    if (input.parentTeamId === id) throw new BadRequestException("A team cannot be its own parent");
    await this.validateRelations(
      org,
      input.managerId ?? undefined,
      input.parentTeamId ?? undefined
    );
    if (input.parentTeamId) await this.assertAcyclic(org, id, input.parentTeamId);
    return this.prisma.team.update({
      where: { id },
      data: {
        ...input,
        ...(input.name
          ? { name: input.name.trim(), slug: await this.uniqueSlug(org, input.name, id) }
          : {}),
        ...(input.description !== undefined
          ? { description: input.description.trim() || null }
          : {})
      }
    });
  }
  async remove(org: string, id: string) {
    await this.get(org, id);
    return this.prisma.team.update({
      where: { id },
      data: { deletedAt: new Date(), status: TeamStatus.ARCHIVED }
    });
  }
  async members(
    org: string,
    id: string,
    q: { page: number; pageSize: number; search?: string; role?: TeamMemberRole }
  ) {
    await this.get(org, id);
    const where: Prisma.TeamMemberWhereInput = {
      teamId: id,
      ...(q.role ? { role: q.role } : {}),
      ...(q.search
        ? {
            user: {
              OR: [
                { firstName: { contains: q.search, mode: "insensitive" } },
                { lastName: { contains: q.search, mode: "insensitive" } },
                { email: { contains: q.search, mode: "insensitive" } }
              ]
            }
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.teamMember.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { createdAt: "asc" },
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, status: true } }
        }
      }),
      this.prisma.teamMember.count({ where })
    ]);
    return {
      items,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        pages: Math.ceil(total / q.pageSize)
      }
    };
  }
  async addMember(org: string, teamId: string, userId: string, role: TeamMemberRole) {
    await this.get(org, teamId);
    await this.assertUser(org, userId);
    try {
      return await this.prisma.teamMember.create({
        data: { teamId, userId, role },
        include: { user: true }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
        throw new ConflictException("User is already a team member");
      throw e;
    }
  }
  async updateMember(org: string, teamId: string, userId: string, role: TeamMemberRole) {
    await this.get(org, teamId);
    const existing = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } }
    });
    if (!existing) throw new NotFoundException("Team member not found");
    return this.prisma.teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role }
    });
  }
  async removeMember(org: string, teamId: string, userId: string) {
    await this.get(org, teamId);
    const result = await this.prisma.teamMember.deleteMany({ where: { teamId, userId } });
    if (!result.count) throw new NotFoundException("Team member not found");
  }
  private async validateRelations(org: string, managerId?: string, parentId?: string) {
    if (managerId) await this.assertUser(org, managerId);
    if (
      parentId &&
      !(await this.prisma.team.count({
        where: { id: parentId, organizationId: org, deletedAt: null }
      }))
    )
      throw new BadRequestException("Parent team is invalid");
  }
  private async assertUser(org: string, id: string) {
    if (!(await this.prisma.user.count({ where: { id, organizationId: org, deletedAt: null } })))
      throw new BadRequestException("User must belong to the organization");
  }
  private async assertAcyclic(org: string, id: string, parentId: string) {
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id || seen.has(cursor))
        throw new BadRequestException("Team hierarchy cannot contain a cycle");
      seen.add(cursor);
      const team: { parentTeamId: string | null } | null = await this.prisma.team.findFirst({
        where: { id: cursor, organizationId: org, deletedAt: null },
        select: { parentTeamId: true }
      });
      cursor = team?.parentTeamId ?? null;
    }
  }
  private async uniqueSlug(org: string, name: string, excludeId?: string) {
    const base =
      name
        .trim()
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "team";
    let slug = base,
      n = 2;
    while (
      await this.prisma.team.count({
        where: { organizationId: org, slug, ...(excludeId ? { id: { not: excludeId } } : {}) }
      })
    )
      slug = `${base}-${n++}`;
    return slug;
  }
}
