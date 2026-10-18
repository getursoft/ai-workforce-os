import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import { SECURITY_CONFIG, type SecurityConfig } from "./security-config";

/**
 * Universal platform owner ("superadmin").
 *
 * One fixed email (SecurityConfig.platformOwnerEmail, env PLATFORM_OWNER_EMAIL) is the sole owner of
 * the whole platform. This is distinct from per-organization "Owner" roles: the platform owner can
 * access and administer EVERY organization, create organizations, see the complete dashboard, and
 * manage payment settings and plugins in any organization. Everything else is gated by normal RBAC.
 */
@Injectable()
export class PlatformOwnerService {
  constructor(
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    private readonly prisma: PrismaService
  ) {}

  isPlatformOwnerEmail(email: string | null | undefined): boolean {
    const configured = this.security.platformOwnerEmail;
    if (!configured || !email) return false;
    return email.trim().toLowerCase() === configured.trim().toLowerCase();
  }

  isPlatformOwnerPrincipal(principal: AuthenticatedPrincipal | null | undefined): boolean {
    return principal?.isPlatformOwner === true;
  }

  /**
   * True when `organizationId` is the platform owner's OWN organization — i.e. it has a User row
   * whose email is the configured platform-owner email. `normalizedEmail` is globally unique (one row
   * platform-wide), so this is unambiguous. Used to exempt the platform's own operating organization
   * from ordinary tenant billing/entitlement enforcement (EntitlementService, BillingEnforcementService)
   * — never used for authorization/RBAC, which stays governed by `isPlatformOwnerPrincipal` and normal
   * per-organization roles.
   */
  async isPlatformOwnerOrganization(organizationId: string): Promise<boolean> {
    const configured = this.security.platformOwnerEmail?.trim().toLowerCase();
    if (!configured) return false;
    const count = await this.prisma.user.count({
      where: { organizationId, normalizedEmail: configured }
    });
    return count > 0;
  }
}
