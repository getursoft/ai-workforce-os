import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthorizationService } from "../../application/services/authorization.service";
import { PERMISSION_METADATA, type PermissionRequirement } from "./permission.decorators";
import type { IdentityRequest } from "./request-context";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement>(
      PERMISSION_METADATA,
      [context.getHandler(), context.getClass()]
    );
    if (!requirement) return true;
    const principal = context.switchToHttp().getRequest<IdentityRequest>().principal;
    if (!principal) throw new ForbiddenException("Authenticated principal is required");
    const allowed =
      requirement.mode === "any"
        ? await this.authorization.hasAnyPermission(
            principal.userId.toString(),
            principal.organizationId.toString(),
            requirement.permissions
          )
        : await this.authorization.hasAllPermissions(
            principal.userId.toString(),
            principal.organizationId.toString(),
            requirement.permissions
          );
    if (!allowed) throw new ForbiddenException("Insufficient permissions");
    return true;
  }
}
