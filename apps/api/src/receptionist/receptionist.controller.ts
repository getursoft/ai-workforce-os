import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { ReceptionistService } from "./receptionist.service";

@ApiTags("Receptionist")
@ApiBearerAuth()
@Controller("receptionist")
@UseGuards(JwtAccessGuard, PermissionGuard)
export class ReceptionistController {
  constructor(private readonly receptionist: ReceptionistService) {}

  @Get("front-door")
  @RequirePermission("agents.run")
  getFrontDoor(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.receptionist.frontDoor(principal.organizationId.toString());
  }
}
