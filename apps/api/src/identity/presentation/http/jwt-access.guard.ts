import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import {
  ACCESS_TOKEN_SERVICE,
  type AccessTokenService
} from "../../application/ports/access-token-service";
import type { IdentityRequest } from "./request-context";
import { SecurityEventLogger } from "./security-event-logger";
import { PrismaService } from "../../../infrastructure/prisma/prisma.service";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../../infrastructure/security/security-config";
import { ApiKeyCrypto } from "../../../service-accounts/api-key.crypto";
import { OrganizationId } from "../../domain/organization/organization-id";
import { ApiKeyStatus, OrganizationStatus, ServiceAccountStatus } from "@prisma/client";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import { identityError } from "../../application/errors/identity.error";

const BEARER = /^Bearer ([^\s,]+)$/;
const API_KEY = /^ApiKey ([^\s,]+)$/;

@Injectable()
export class JwtAccessGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
    private readonly securityLogger: SecurityEventLogger,
    private readonly prisma: PrismaService,
    @Inject(SECURITY_CONFIG) private readonly config: SecurityConfig
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const authorization = request.header("authorization");
    const match = authorization?.match(BEARER);
    const apiKeyMatch = authorization?.match(API_KEY);
    if (apiKeyMatch?.[1]) {
      const path =
        (request as unknown as { originalUrl?: string; path?: string }).originalUrl ??
        (request as unknown as { path?: string }).path ??
        "";
      if (/\/(auth|organizations|users|roles|permissions|invitations)(\/|\?|$)/.test(path))
        throw new UnauthorizedException();
      try {
        await this.authenticateApiKey(request, apiKeyMatch[1]);
        return true;
      } catch {
        throw new UnauthorizedException();
      }
    }
    if (!match?.[1]) {
      this.securityLogger.failure(
        "me_unauthorized",
        request.requestId,
        "missing_or_malformed_bearer"
      );
      throw new UnauthorizedException();
    }
    try {
      request.principal = await this.accessTokens.verify(match[1]);
    } catch {
      this.securityLogger.failure("me_unauthorized", request.requestId, "invalid_access_token");
      throw new UnauthorizedException();
    }
    // Phase 5.2 — organization suspension enforcement. The access token itself is a self-contained,
    // stateless JWT (JoseAccessTokenService.verify does signature + expiry only, no DB read) — it stays
    // cryptographically valid for its full TTL regardless of anything that happens to the organization
    // after issuance. This guard is the one shared boundary every tenant-scoped controller in the
    // codebase runs through before any handler or PermissionGuard logic, so it is the authoritative place
    // to re-derive organization state fresh on every single request, not just at login/refresh. Mirrors
    // the already-established, already-reviewed policy in OrganizationAccessService (used by /auth/me,
    // GET /organizations/:id, and the organization-settings handlers) verbatim: a non-ACTIVE organization
    // blocks access for EVERY principal resolved into it, with no platform-owner exception — switching
    // into a suspended organization is already refused by SwitchOrganizationHandler, so a platform owner
    // never legitimately holds a token scoped to one. Always a fresh, uncached DB read (same approach as
    // the API-key branch above and AuthorizationService.canAccessOrganization/getEffectivePermissions
    // below) — never trusts a cache for this, so a stale permission cache can never bypass a suspension.
    const organization = await this.prisma.organization.findUnique({
      where: { id: request.principal.organizationId.toString() },
      select: { status: true }
    });
    if (!organization || organization.status !== OrganizationStatus.ACTIVE) {
      this.securityLogger.failure("me_unauthorized", request.requestId, "organization_inactive");
      throw identityError.organizationInactive();
    }
    return true;
  }
  private async authenticateApiKey(request: IdentityRequest, raw: string): Promise<void> {
    const parsed = new ApiKeyCrypto(this.config.apiKey.pepper).parse(raw);
    if (!parsed) throw new Error();
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
    if (
      !key ||
      key.environment.toLowerCase() !== parsed.environment ||
      !new ApiKeyCrypto(this.config.apiKey.pepper).verify(parsed.secret, key.secretHash) ||
      key.status !== ApiKeyStatus.ACTIVE ||
      key.revokedAt ||
      (key.expiresAt && key.expiresAt <= new Date()) ||
      key.serviceAccount.status !== ServiceAccountStatus.ACTIVE ||
      key.serviceAccount.deletedAt ||
      key.serviceAccount.organization.status !== OrganizationStatus.ACTIVE
    )
      throw new Error();
    request.servicePermissions = [
      ...new Set(
        key.serviceAccount.roles.flatMap((x) => x.role.permissions.map((y) => y.permission.key))
      )
    ];
    request.principal = {
      organizationId: OrganizationId.from(key.organizationId),
      serviceAccountId: key.serviceAccountId,
      apiKeyId: key.id,
      principalType: "SERVICE_ACCOUNT"
    } as unknown as AuthenticatedPrincipal;
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 300000)
      void this.prisma.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
  }
}
