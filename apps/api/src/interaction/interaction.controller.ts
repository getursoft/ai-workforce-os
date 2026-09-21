/** Sprint 7.12 STEP 26 — mirrors VoiceCallHistoryController's exact RBAC/guard/decorator pattern.
 * Reuses "agents.conversations.read" rather than minting a new permission string for a cross-channel
 * read endpoint that has no more-sensitive sibling the way voice transcripts did. */
import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { APP_CONFIG, type AppConfig } from "../config/config.tokens";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { InteractionAdminService } from "./interaction-admin.service";
import { InteractionListQueryDto } from "./interaction.dto";

function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}

@ApiTags("Interactions")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("interactions")
export class InteractionController {
  constructor(
    private readonly interactions: InteractionAdminService,
    @Inject(APP_CONFIG) private readonly config: AppConfig
  ) {}

  @Get() @RequirePermission("agents.conversations.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: InteractionListQueryDto
  ) {
    return this.interactions.list(org(p), query);
  }

  @Get("reference/:referenceId") @RequirePermission("agents.conversations.read") getByReference(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("referenceId") referenceId: string
  ) {
    const prefixLength = this.config.string("INTERACTION_REFERENCE_PREFIX", "KRV").length;
    return this.interactions.getByReferenceId(org(p), referenceId, prefixLength);
  }

  @Get(":id") @RequirePermission("agents.conversations.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.interactions.get(org(p), id);
  }

  @Get(":id/notifications") @RequirePermission("agents.conversations.read") notifications(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.interactions.notifications(org(p), id);
  }
}
