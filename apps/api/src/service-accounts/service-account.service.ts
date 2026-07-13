import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import {
  ApiKeyEnvironment,
  ApiKeyStatus,
  OrganizationStatus,
  Prisma,
  ServiceAccountStatus
} from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { ApiKeyCrypto, type KeyEnvironment } from "./api-key.crypto";
const keySelect = {
  id: true,
  organizationId: true,
  serviceAccountId: true,
  name: true,
  keyPrefix: true,
  publicId: true,
  maskedValue: true,
  environment: true,
  status: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  updatedAt: true,
  replacementKeyId: true
} as const;
@Injectable()
export class ServiceAccountService {
  private readonly crypto: ApiKeyCrypto;
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SECURITY_CONFIG) config: SecurityConfig
  ) {
    this.crypto = new ApiKeyCrypto(config.apiKey.pepper);
  }
  async list(
    org: string,
    q: { page: number; pageSize: number; search?: string; status?: ServiceAccountStatus }
  ) {
    const where: Prisma.ServiceAccountWhereInput = {
      organizationId: org,
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
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
      this.prisma.serviceAccount.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { name: "asc" },
        include: {
          roles: { include: { role: true } },
          _count: { select: { apiKeys: true } },
          apiKeys: {
            where: { status: ApiKeyStatus.ACTIVE },
            orderBy: { lastUsedAt: "desc" },
            take: 1,
            select: { lastUsedAt: true }
          }
        }
      }),
      this.prisma.serviceAccount.count({ where })
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
    const value = await this.prisma.serviceAccount.findFirst({
      where: { id, organizationId: org, deletedAt: null },
      include: {
        roles: {
          include: { role: { include: { permissions: { include: { permission: true } } } } }
        },
        apiKeys: { select: keySelect, orderBy: { createdAt: "desc" } },
        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } }
      }
    });
    if (!value) throw new NotFoundException("Service account not found");
    return value;
  }
  async create(
    org: string,
    actor: string,
    input: { name: string; description?: string; roleIds: string[] }
  ) {
    await this.roles(org, input.roleIds);
    try {
      return await this.prisma.serviceAccount.create({
        data: {
          organizationId: org,
          name: input.name.trim(),
          description: input.description?.trim() ?? null,
          createdByUserId: actor,
          roles: { create: input.roleIds.map((roleId) => ({ roleId })) }
        },
        include: { roles: { include: { role: true } } }
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
        throw new ConflictException("Service account name already exists");
      throw e;
    }
  }
  async update(
    org: string,
    id: string,
    input: {
      name?: string;
      description?: string;
      status?: ServiceAccountStatus;
      roleIds?: string[];
    }
  ) {
    await this.get(org, id);
    if (input.roleIds) await this.roles(org, input.roleIds);
    return this.prisma.$transaction(async (tx) => {
      await tx.serviceAccount.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined
            ? { description: input.description.trim() || null }
            : {}),
          ...(input.status ? { status: input.status } : {})
        }
      });
      if (input.roleIds) {
        await tx.serviceAccountRole.deleteMany({ where: { serviceAccountId: id } });
        await tx.serviceAccountRole.createMany({
          data: input.roleIds.map((roleId) => ({ serviceAccountId: id, roleId }))
        });
      }
      return tx.serviceAccount.findUniqueOrThrow({
        where: { id },
        include: { roles: { include: { role: true } } }
      });
    });
  }
  async remove(org: string, id: string, actor: string) {
    await this.get(org, id);
    await this.prisma.$transaction([
      this.prisma.apiKey.updateMany({
        where: { serviceAccountId: id, status: ApiKeyStatus.ACTIVE },
        data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date(), revokedByUserId: actor }
      }),
      this.prisma.serviceAccount.update({
        where: { id },
        data: { status: ServiceAccountStatus.ARCHIVED, deletedAt: new Date() }
      })
    ]);
  }
  async createKey(
    org: string,
    accountId: string,
    actor: string,
    input: { name: string; environment: ApiKeyEnvironment; expiresAt?: string }
  ) {
    await this.get(org, accountId);
    const expires = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expires && expires <= new Date())
      throw new BadRequestException("Expiry must be in the future");
    const env = input.environment.toLowerCase() as KeyEnvironment;
    const generated = this.crypto.generate(env);
    const metadata = await this.prisma.apiKey.create({
      data: {
        organizationId: org,
        serviceAccountId: accountId,
        name: input.name.trim(),
        keyPrefix: generated.keyPrefix,
        publicId: generated.publicId,
        maskedValue: generated.maskedValue,
        secretHash: generated.secretHash,
        environment: input.environment,
        expiresAt: expires,
        createdByUserId: actor
      },
      select: keySelect
    });
    return {
      apiKey: metadata,
      secret: generated.plaintext,
      message: "Copy this API key now. It will not be shown again."
    };
  }
  async keys(org: string, accountId: string) {
    await this.get(org, accountId);
    return this.prisma.apiKey.findMany({
      where: { organizationId: org, serviceAccountId: accountId },
      select: keySelect,
      orderBy: { createdAt: "desc" }
    });
  }
  async revoke(org: string, accountId: string, keyId: string, actor: string) {
    await this.get(org, accountId);
    const key = await this.prisma.apiKey.findFirst({
      where: { id: keyId, organizationId: org, serviceAccountId: accountId }
    });
    if (!key) throw new NotFoundException("API key not found");
    if (key.status === ApiKeyStatus.REVOKED)
      return this.prisma.apiKey.findUniqueOrThrow({ where: { id: keyId }, select: keySelect });
    return this.prisma.apiKey.update({
      where: { id: keyId },
      data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date(), revokedByUserId: actor },
      select: keySelect
    });
  }
  async rotate(org: string, accountId: string, keyId: string, actor: string) {
    const old = await this.prisma.apiKey.findFirst({
      where: {
        id: keyId,
        organizationId: org,
        serviceAccountId: accountId,
        status: ApiKeyStatus.ACTIVE,
        revokedAt: null
      }
    });
    if (!old || (old.expiresAt && old.expiresAt <= new Date()))
      throw new BadRequestException("API key cannot be rotated");
    const generated = this.crypto.generate(old.environment.toLowerCase() as KeyEnvironment);
    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          organizationId: org,
          serviceAccountId: accountId,
          name: `${old.name} (rotated)`,
          keyPrefix: generated.keyPrefix,
          publicId: generated.publicId,
          maskedValue: generated.maskedValue,
          secretHash: generated.secretHash,
          environment: old.environment,
          expiresAt: old.expiresAt,
          createdByUserId: actor
        },
        select: keySelect
      });
      await tx.apiKey.update({
        where: { id: old.id },
        data: {
          status: ApiKeyStatus.REVOKED,
          revokedAt: new Date(),
          revokedByUserId: actor,
          replacementKeyId: created.id
        }
      });
      return created;
    });
    return {
      apiKey: result,
      secret: generated.plaintext,
      message: "Copy this API key now. It will not be shown again."
    };
  }
  async authenticate(raw: string) {
    const parsed = this.crypto.parse(raw);
    if (!parsed) throw new UnauthorizedException();
    const key = await this.prisma.apiKey.findUnique({
      where: { publicId: parsed.publicId },
      include: {
        serviceAccount: {
          include: {
            organization: true,
            roles: {
              include: { role: { include: { permissions: { include: { permission: true } } } } }
            }
          }
        }
      }
    });
    const invalid =
      !key ||
      !this.crypto.verify(parsed.secret, key.secretHash) ||
      key.status !== ApiKeyStatus.ACTIVE ||
      Boolean(key.revokedAt) ||
      Boolean(key.expiresAt && key.expiresAt <= new Date()) ||
      key.environment.toLowerCase() !== parsed.environment ||
      key.serviceAccount.status !== ServiceAccountStatus.ACTIVE ||
      Boolean(key.serviceAccount.deletedAt) ||
      key.serviceAccount.organization.status !== OrganizationStatus.ACTIVE;
    if (invalid) throw new UnauthorizedException();
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 300000)
      void this.prisma.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    return {
      serviceAccountId: key.serviceAccountId,
      organizationId: key.organizationId,
      apiKeyId: key.id,
      effectivePermissions: [
        ...new Set(
          key.serviceAccount.roles.flatMap((x) => x.role.permissions.map((y) => y.permission.key))
        )
      ]
    };
  }
  private async roles(org: string, ids: string[]) {
    const roles=await this.prisma.role.findMany({where:{id:{in:ids},organizationId:org},select:{id:true,name:true,isSystem:true}});
    if (
      new Set(ids).size !== ids.length ||
      roles.length !== ids.length || roles.some(role=>role.isSystem&&["Owner","Admin"].includes(role.name))
    )
      throw new BadRequestException("One or more roles are invalid");
  }
}
