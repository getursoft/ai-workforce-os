import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { LegacyUserRole, OrganizationStatus, UserStatus } from "@prisma/client";
import argon2 from "argon2";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { identityError } from "../errors/identity.error";

/** A lightweight, public-safe organization summary used by the platform-owner org dropdown. */
export interface PlatformOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface OnboardedOwnerAccount {
  id: string;
  email: string;
  firstName: string;
  role: string;
  status: string;
}

/**
 * Platform-owner operations: list every organization in the platform and create new ones. Only the
 * universal platform owner may call these (enforced by PlatformOwnerGuard at the controller layer).
 */
@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  async listOrganizations(): Promise<PlatformOrganizationSummary[]> {
    const rows = await this.prisma.organization.findMany({
      where: {},
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, slug: true, status: true }
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status
    }));
  }

  async createOrganization(input: {
    name: string;
    actorId: string;
    ownerEmail?: string;
    ownerFirstName?: string;
    ownerLastName?: string;
    ownerPassword?: string;
  }): Promise<{
    organization: PlatformOrganizationSummary;
    owner?: OnboardedOwnerAccount;
  }> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 120) {
      throw new BadRequestException("ORGANIZATION_NAME_INVALID");
    }
    // Optional: onboard the company's first owner login in the same step ("onboard a new company").
    if (input.ownerEmail) {
      if (!input.ownerFirstName?.trim()) throw new BadRequestException("OWNER_FIRST_NAME_REQUIRED");
      if (!input.ownerPassword || input.ownerPassword.length < 12)
        throw new BadRequestException("OWNER_PASSWORD_WEAK");
    }
    const slug = await this.uniqueSlug(name);
    const created = await this.prisma.organization.create({
      data: {
        name,
        slug,
        status: OrganizationStatus.ACTIVE
      },
      select: { id: true, name: true, slug: true, status: true }
    });
    let owner: OnboardedOwnerAccount | undefined;
    if (input.ownerEmail) {
      const normalizedEmail = input.ownerEmail.trim().toLowerCase();
      if (
        await this.prisma.user.count({
          where: { normalizedEmail, deletedAt: null }
        })
      ) {
        throw new BadRequestException("OWNER_EMAIL_ALREADY_EXISTS");
      }
      const user = await this.prisma.user.create({
        data: {
          organizationId: created.id,
          firstName: input.ownerFirstName?.trim() ?? "",
          lastName: input.ownerLastName?.trim() ?? null,
          email: input.ownerEmail.trim(),
          normalizedEmail,
          passwordHash: await argon2.hash(input.ownerPassword ?? ""),
          // Legacy OWNER role: the users_assign_legacy_role trigger links it to the Owner system role.
          role: LegacyUserRole.OWNER,
          status: UserStatus.ACTIVE
        },
        select: { id: true, email: true, firstName: true, role: true, status: true }
      });
      owner = {
        id: user.id,
        email: user.email,
        firstName: user.firstName ?? "",
        role: user.role,
        status: user.status
      };
    }
    return {
      organization: {
        id: created.id,
        name: created.name,
        slug: created.slug,
        status: created.status
      },
      ...(owner ? { owner } : {})
    };
  }

  async findOrganization(id: string): Promise<PlatformOrganizationSummary | null> {
    const row = await this.prisma.organization.findFirst({
      where: { id },
      select: { id: true, name: true, slug: true, status: true }
    });
    if (!row) throw new NotFoundException("ORGANIZATION_NOT_FOUND");
    return { id: row.id, name: row.name, slug: row.slug, status: row.status };
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "organization";
    for (let attempt = 1; attempt <= 100; attempt += 1) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
      if (
        !(await this.prisma.organization.count({
          where: { slug: candidate }
        }))
      ) {
        return candidate;
      }
    }
    throw identityError.conflict();
  }
}
