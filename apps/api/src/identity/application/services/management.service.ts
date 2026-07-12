import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { LegacyUserRole, Prisma, UserStatus } from "@prisma/client";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { AuthorizationService } from "./authorization.service";

const SYSTEM_ROLES = ["Owner", "Admin", "Manager", "Member", "Viewer"] as const;
const DEFAULT_PERMISSIONS: Record<(typeof SYSTEM_ROLES)[number], string[]> = {
  Owner: [
    "users.read",
    "users.write",
    "users.delete",
    "roles.read",
    "roles.write",
    "invitations.read",
    "invitations.write",
    "organization.manage"
  ],
  Admin: [
    "users.read",
    "users.write",
    "users.delete",
    "roles.read",
    "roles.write",
    "invitations.read",
    "invitations.write",
    "organization.manage"
  ],
  Manager: ["users.read", "roles.read", "invitations.read", "invitations.write"],
  Member: ["users.read", "roles.read"],
  Viewer: ["users.read"]
};

@Injectable()
export class ManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService
  ) {}
  private async ensureSystemRoles(organizationId: string): Promise<void> {
    const permissions = await this.prisma.permission.findMany();
    for (const name of SYSTEM_ROLES) {
      const role = await this.prisma.role.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name, isSystem: true, description: `${name} system role` },
        update: {}
      });
      const ids = permissions
        .filter((p) => DEFAULT_PERMISSIONS[name].includes(p.key))
        .map((p) => p.id);
      await this.prisma.rolePermission.createMany({
        data: ids.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true
      });
    }
    const legacyUsers = await this.prisma.user.findMany({
      where: { organizationId, userRoles: { none: {} } },
      select: { id: true, role: true }
    });
    const roles = await this.prisma.role.findMany({
      where: { organizationId, isSystem: true },
      select: { id: true, name: true }
    });
    await this.prisma.userRole.createMany({
      data: legacyUsers.flatMap((user) => {
        const name = user.role === "OWNER" ? "Owner" : user.role === "ADMIN" ? "Admin" : "Member";
        const role = roles.find((candidate) => candidate.name === name);
        return role ? [{ userId: user.id, roleId: role.id }] : [];
      }),
      skipDuplicates: true
    });
  }
  async listUsers(
    org: string,
    query: { page: number; pageSize: number; search?: string; status?: UserStatus }
  ) {
    await this.ensureSystemRoles(org);
    const where: Prisma.UserWhereInput = {
      organizationId: org,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: "insensitive" } },
              { lastName: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } }
            ]
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        orderBy: { createdAt: "desc" },
        omit: { passwordHash: true },
        include: { userRoles: { include: { role: true } } }
      }),
      this.prisma.user.count({ where })
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
  async getUser(org: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, organizationId: org, deletedAt: null },
      omit: { passwordHash: true },
      include: { userRoles: { include: { role: true } } }
    });
    if (!user) throw new NotFoundException("User not found");
    return user;
  }
  async createUser(
    org: string,
    input: {
      firstName: string;
      lastName?: string;
      email: string;
      password: string;
      roleIds: string[];
    }
  ) {
    await this.assertRoles(org, input.roleIds);
    const normalizedEmail = input.email.trim().toLowerCase();
    try {
      const user = await this.prisma.user.create({
        data: {
          organizationId: org,
          firstName: input.firstName.trim(),
          lastName: input.lastName?.trim() ?? null,
          email: input.email.trim(),
          normalizedEmail,
          passwordHash: await argon2.hash(input.password),
          role: LegacyUserRole.MEMBER,
          status: UserStatus.ACTIVE,
          userRoles: { create: input.roleIds.map((roleId) => ({ roleId })) }
        },
        omit: { passwordHash: true },
        include: { userRoles: { include: { role: true } } }
      });
      this.authorization.invalidateUser(user.id, org);
      return user;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("Email already exists");
      throw error;
    }
  }
  async updateUser(
    org: string,
    id: string,
    actorId: string,
    input: { firstName?: string; lastName?: string; status?: UserStatus }
  ) {
    const user = await this.getUser(org, id);
    if (id === actorId && input.status && input.status !== UserStatus.ACTIVE)
      throw new ForbiddenException("You cannot deactivate yourself");
    if (this.isOwner(user) && input.status && input.status !== UserStatus.ACTIVE)
      throw new ForbiddenException("The owner cannot be deactivated");
    return this.prisma.user.update({ where: { id }, data: input, omit: { passwordHash: true } });
  }
  async deleteUser(org: string, id: string, actorId: string) {
    const user = await this.getUser(org, id);
    if (id === actorId) throw new ForbiddenException("You cannot delete yourself");
    if (this.isOwner(user)) throw new ForbiddenException("The owner cannot be deleted");
    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), status: UserStatus.DISABLED }
    });
    await this.prisma.authenticationSession.deleteMany({ where: { userId: id } });
    this.authorization.invalidateUser(id, org);
  }
  async assignRoles(org: string, id: string, actorId: string, roleIds: string[]) {
    const user = await this.getUser(org, id);
    await this.assertRoles(org, roleIds);
    if (
      this.isOwner(user) &&
      !roleIds.some((roleId) =>
        user.userRoles.some((x) => x.role.id === roleId && x.role.name === "Owner")
      )
    )
      throw new ForbiddenException("The Owner role cannot be removed from the owner");
    if (
      id === actorId &&
      !roleIds.some((roleId) => user.userRoles.some((x) => x.role.id === roleId))
    )
      throw new ForbiddenException("You cannot remove all of your own current roles");
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: id } }),
      this.prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) })
    ]);
    this.authorization.invalidateUser(id, org);
    return this.getUser(org, id);
  }
  async listRoles(org: string) {
    await this.ensureSystemRoles(org);
    return this.prisma.role.findMany({
      where: { organizationId: org },
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } }
      },
      orderBy: { name: "asc" }
    });
  }
  async createRole(
    org: string,
    input: { name: string; description?: string; permissionIds?: string[] }
  ) {
    await this.assertPermissions(input.permissionIds ?? []);
    const role = await this.prisma.role.create({
      data: {
        organizationId: org,
        name: input.name,
        description: input.description ?? null,
        permissions: {
          create: (input.permissionIds ?? []).map((permissionId) => ({ permissionId }))
        }
      },
      include: { permissions: { include: { permission: true } } }
    });
    this.authorization.invalidateOrganization(org);
    return role;
  }
  async updateRole(org: string, id: string, input: { name?: string; description?: string }) {
    const role = await this.role(org, id);
    if (role.isSystem) throw new ForbiddenException("System roles cannot be renamed or modified");
    const result = await this.prisma.role.update({ where: { id }, data: input });
    this.authorization.invalidateOrganization(org);
    return result;
  }
  async deleteRole(org: string, id: string) {
    const role = await this.role(org, id);
    if (role.isSystem) throw new ForbiddenException("System roles cannot be deleted");
    if (await this.prisma.userRole.count({ where: { roleId: id } }))
      throw new ConflictException("Role is assigned to users");
    await this.prisma.role.delete({ where: { id } });
    this.authorization.invalidateOrganization(org);
  }
  async assignPermissions(org: string, id: string, permissionIds: string[]) {
    const role = await this.role(org, id);
    if (role.isSystem) throw new ForbiddenException("System role permissions cannot be modified");
    await this.assertPermissions(permissionIds);
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
      this.prisma.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({ roleId: id, permissionId }))
      })
    ]);
    this.authorization.invalidateOrganization(org);
    return this.role(org, id);
  }
  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { key: "asc" } });
  }
  async listInvitations(org: string) {
    return this.prisma.invitation.findMany({
      where: { organizationId: org },
      orderBy: { createdAt: "desc" }
    });
  }
  async invite(org: string, actorId: string, email: string, roleIds: string[]) {
    await this.assertRoles(org, roleIds);
    const normalizedEmail = email.trim().toLowerCase();
    if (
      await this.prisma.user.count({
        where: { organizationId: org, normalizedEmail, deletedAt: null }
      })
    )
      throw new ConflictException("User already exists");
    await this.prisma.invitation.updateMany({
      where: { organizationId: org, normalizedEmail, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    return this.createInvitation(org, actorId, email, normalizedEmail, roleIds);
  }
  async resend(org: string, id: string, actorId: string) {
    const invitation = await this.invitation(org, id);
    if (invitation.acceptedAt || invitation.revokedAt)
      throw new BadRequestException("Invitation is no longer active");
    await this.prisma.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
    return this.createInvitation(
      org,
      actorId,
      invitation.email,
      invitation.normalizedEmail,
      this.roleIds(invitation.roleIds)
    );
  }
  async revoke(org: string, id: string) {
    const invitation = await this.invitation(org, id);
    if (invitation.acceptedAt)
      throw new BadRequestException("Accepted invitations cannot be revoked");
    return this.prisma.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
  }
  async accept(token: string, input: { firstName: string; lastName?: string; password: string }) {
    const hash = this.hashToken(token);
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: hash } });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date()
    )
      throw new BadRequestException("Invitation is invalid or expired");
    const roleIds = this.roleIds(invitation.roleIds);
    await this.assertRoles(invitation.organizationId, roleIds);
    const user = await this.createUser(invitation.organizationId, {
      ...input,
      email: invitation.email,
      roleIds
    });
    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() }
    });
    return user;
  }
  private async createInvitation(
    org: string,
    actorId: string,
    email: string,
    normalizedEmail: string,
    roleIds: string[]
  ) {
    const token = randomBytes(32).toString("base64url");
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId: org,
        email,
        normalizedEmail,
        tokenHash: this.hashToken(token),
        roleIds,
        invitedById: actorId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });
    return { invitation, token };
  }
  private hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  private roleIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string"))
      throw new BadRequestException("Invitation roles are invalid");
    return value;
  }
  private isOwner(user: { userRoles: { role: { name: string } }[] }): boolean {
    return user.userRoles.some(({ role }) => role.name === "Owner");
  }
  private async role(org: string, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, organizationId: org },
      include: { permissions: { include: { permission: true } } }
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }
  private async invitation(org: string, id: string) {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id, organizationId: org }
    });
    if (!invitation) throw new NotFoundException("Invitation not found");
    return invitation;
  }
  private async assertRoles(org: string, ids: string[]) {
    if (
      new Set(ids).size !== ids.length ||
      (await this.prisma.role.count({ where: { id: { in: ids }, organizationId: org } })) !==
        ids.length
    )
      throw new BadRequestException("One or more roles are invalid");
  }
  private async assertPermissions(ids: string[]) {
    if (
      new Set(ids).size !== ids.length ||
      (await this.prisma.permission.count({ where: { id: { in: ids } } })) !== ids.length
    )
      throw new BadRequestException("One or more permissions are invalid");
  }
}
