import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedPrincipal } from "../../application/ports/authenticated-principal";
import type { IdentityRequest } from "./request-context";

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    if (!request.principal) {
      throw new Error("Authenticated principal is unavailable");
    }
    return request.principal;
  }
);
