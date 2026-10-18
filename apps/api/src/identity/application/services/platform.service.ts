import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { LegacyUserRole, OrganizationStatus, UserStatus } from "@prisma/client";
import argon2 from "argon2";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import { identityError } from "../errors/identity.error";
import { AuthorizationService } from "./authorization.service";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService
  ) {}

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

  /**
   * Sprint 5.0 Phase 13: platform-admin console. Suspend/reactivate reuse the existing
   * OrganizationStatus enum (ACTIVE/SUSPENDED/DISABLED) that LoginHandler already enforces
   * (`organization.status !== ACTIVE` → generic authentication-failed, never distinguishing suspended
   * from wrong-password — that's an existing, intentional anti-enumeration choice, unchanged here). This
   * is the first thing that actually WRITES that status outside org creation.
   *
   * Phase 5.2: JwtAccessGuard and AuthorizationService both re-derive organization status fresh on every
   * request/permission check now, so correctness never depended on this cache invalidation — but a still
   * live (not-yet-expired) PermissionGuard-cached grant from moments before suspension would otherwise
   * keep serving stale `true` results for up to the cache's 5-minute TTL. invalidateOrganization clears
   * every cached entry for this org immediately, for both directions (suspend AND reactivate), so neither
   * transition has to wait out that window.
   */
  async suspendOrganization(id: string, actorId: string, reason?: string): Promise<PlatformOrganizationSummary> {
    await this.findOrganization(id);
    const row = await this.prisma.organization.update({
      where: { id },
      data: { status: OrganizationStatus.SUSPENDED },
      select: { id: true, name: true, slug: true, status: true }
    });
    this.authorization.invalidateOrganization(id);
    if (reason?.trim()) await this.addSupportNote(id, actorId, `Organization suspended: ${reason.trim()}`);
    return row;
  }

  async reactivateOrganization(id: string, actorId: string): Promise<PlatformOrganizationSummary> {
    await this.findOrganization(id);
    const row = await this.prisma.organization.update({
      where: { id },
      data: { status: OrganizationStatus.ACTIVE },
      select: { id: true, name: true, slug: true, status: true }
    });
    this.authorization.invalidateOrganization(id);
    await this.addSupportNote(id, actorId, "Organization reactivated.");
    return row;
  }

  async addSupportNote(organizationId: string, authorUserId: string, body: string): Promise<{ id: string; body: string; createdAt: Date }> {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 4000) throw new BadRequestException("SUPPORT_NOTE_INVALID");
    await this.findOrganization(organizationId);
    return this.prisma.platformSupportNote.create({
      data: { organizationId, authorUserId, body: trimmed },
      select: { id: true, body: true, createdAt: true }
    });
  }

  async listSupportNotes(organizationId: string): Promise<Array<{ id: string; body: string; authorUserId: string; createdAt: Date }>> {
    await this.findOrganization(organizationId);
    return this.prisma.platformSupportNote.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, body: true, authorUserId: true, createdAt: true }
    });
  }

  /**
   * Tenant-safe operational summary: counts and status only — never raw prompts, document contents,
   * memory values, or secrets (explicit platform-admin constraint). Uses direct Prisma queries rather
   * than injecting BillingService/EntitlementService/ObservabilityAlertsService, since those modules all
   * import IdentityModule already — injecting them here would be a circular module dependency.
   */
  async operationalSummary(organizationId: string) {
    const organization = await this.findOrganization(organizationId);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [subscription, activeEmployees, users, channels, failedExecutions24h, openAlerts, supportNotes] = await Promise.all([
      this.prisma.organisationSubscription.findUnique({ where: { organizationId }, include: { plan: true } }),
      this.prisma.plugin.count({ where: { organizationId, deletedAt: null, status: "ACTIVE" } }),
      this.prisma.user.count({ where: { organizationId, status: "ACTIVE" } }),
      this.prisma.channelConnection.count({ where: { organizationId, status: { not: "DISABLED" } } }),
      this.prisma.agentExecution.count({ where: { organizationId, status: "FAILED", createdAt: { gte: since24h } } }),
      this.prisma.observabilityAlert.count({ where: { organizationId, status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      this.prisma.platformSupportNote.count({ where: { organizationId } })
    ]);
    const usedCreditsAgg = subscription
      ? await this.prisma.agentExecution.aggregate({
          where: { organizationId, status: "COMPLETED", createdAt: { gte: subscription.billingCycleStart, lte: subscription.billingCycleEnd } },
          _sum: { totalTokens: true }
        })
      : null;
    return {
      organization,
      subscription: subscription
        ? {
            status: subscription.status,
            planCode: subscription.plan.code,
            planName: subscription.plan.name,
            monthlyCreditAllowance: subscription.monthlyCreditAllowanceOverride ?? subscription.plan.monthlyCreditAllowance,
            usedCredits: Math.ceil(((usedCreditsAgg?._sum.totalTokens ?? 0) * 4) / 1000)
          }
        : null,
      activeEmployees,
      users,
      channels,
      failedExecutionsLast24h: failedExecutions24h,
      openAlerts,
      supportNotes
    };
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
