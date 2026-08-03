import {
  ExpiredAccessTokenError,
  InvalidAccessTokenError
} from "../../application/errors/security.error";
import type { AccessTokenService } from "../../application/ports/access-token-service";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import type { Clock } from "../../application/ports/clock";
import { AuthenticationSessionId } from "../../domain/authentication/authentication-session-id";
import { OrganizationId } from "../../domain/organization/organization-id";
import { UserId } from "../../domain/user/user-id";
import { UserRole } from "../../domain/user/user-role";
import type { SecurityConfig } from "./security-config";

type AccessTokenConfig = SecurityConfig["accessToken"];

export class JoseAccessTokenService implements AccessTokenService {
  private readonly key: Uint8Array;

  constructor(
    private readonly config: AccessTokenConfig,
    private readonly clock: Clock
  ) {
    this.key = new TextEncoder().encode(config.secret);
  }

  async issue(principal: AuthenticatedPrincipal, issuedAt: Date): Promise<string> {
    if (!Number.isFinite(issuedAt.getTime())) {
      throw new InvalidAccessTokenError();
    }
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1000);
    try {
      const { SignJWT } = await import("jose");
      return await new SignJWT({
        org: principal.organizationId.toString(),
        role: principal.role,
        sid: principal.sessionId.toString(),
        ...(principal.isPlatformOwner ? { po: true } : {}),
        type: "access"
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(principal.userId.toString())
        .setIssuedAt(issuedAtSeconds)
        .setExpirationTime(issuedAtSeconds + this.config.expiresInSeconds)
        .setIssuer(this.config.issuer)
        .setAudience(this.config.audience)
        .sign(this.key);
    } catch {
      throw new InvalidAccessTokenError();
    }
  }

  async verify(token: string): Promise<AuthenticatedPrincipal> {
    try {
      const jose = await import("jose");
      const { payload } = await jose.jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: this.config.issuer,
        audience: this.config.audience,
        currentDate: this.clock.now()
      });
      return this.toPrincipal(payload);
    } catch (error: unknown) {
      const jose = await import("jose");
      if (error instanceof jose.errors.JWTExpired) {
        throw new ExpiredAccessTokenError();
      }
      if (error instanceof ExpiredAccessTokenError) {
        throw error;
      }
      throw new InvalidAccessTokenError();
    }
  }

  private toPrincipal(payload: Record<string, unknown>): AuthenticatedPrincipal {
    if (
      typeof payload.sub !== "string" ||
      typeof payload.org !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.sid !== "string" ||
      payload.type !== "access" ||
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat
    ) {
      throw new InvalidAccessTokenError();
    }
    return {
      userId: UserId.from(payload.sub),
      organizationId: OrganizationId.from(payload.org),
      role: this.toRole(payload.role),
      sessionId: AuthenticationSessionId.from(payload.sid),
      ...(payload.po === true ? { isPlatformOwner: true } : {})
    };
  }

  private toRole(value: string): UserRole {
    const role = Object.values(UserRole).find((candidate) => candidate === value);
    if (!role) {
      throw new InvalidAccessTokenError();
    }
    return role;
  }
}
