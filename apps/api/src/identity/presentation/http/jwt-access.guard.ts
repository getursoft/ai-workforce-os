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

const BEARER = /^Bearer ([^\s,]+)$/;

@Injectable()
export class JwtAccessGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_SERVICE) private readonly accessTokens: AccessTokenService,
    private readonly securityLogger: SecurityEventLogger
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const authorization = request.header("authorization");
    const match = authorization?.match(BEARER);
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
      return true;
    } catch {
      this.securityLogger.failure("me_unauthorized", request.requestId, "invalid_access_token");
      throw new UnauthorizedException();
    }
  }
}
