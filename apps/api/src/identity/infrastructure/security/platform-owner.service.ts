import { Inject, Injectable } from "@nestjs/common";
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
  constructor(@Inject(SECURITY_CONFIG) private readonly security: SecurityConfig) {}

  isPlatformOwnerEmail(email: string | null | undefined): boolean {
    const configured = this.security.platformOwnerEmail;
    if (!configured || !email) return false;
    return email.trim().toLowerCase() === configured.trim().toLowerCase();
  }

  isPlatformOwnerPrincipal(principal: AuthenticatedPrincipal | null | undefined): boolean {
    return principal?.isPlatformOwner === true;
  }
}
