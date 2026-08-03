import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { IdentityRequest } from "../../presentation/http/request-context";
import { PlatformOwnerService } from "./platform-owner.service";

/** Guards a route so only the universal platform owner may call it. */
@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  constructor(private readonly platformOwner: PlatformOwnerService) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    if (!this.platformOwner.isPlatformOwnerPrincipal(request.principal)) {
      throw new ForbiddenException("PLATFORM_OWNER_ONLY");
    }
    return true;
  }
}
