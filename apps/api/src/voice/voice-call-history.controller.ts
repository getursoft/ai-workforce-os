/** Sprint 7.11 — STEP 4: Call History API. Mirrors ChannelController's exact RBAC/guard/decorator
 * pattern. List/detail reuse the existing "channel.message.read" permission (no need for a new
 * permission string when an equivalent one already covers "read channel conversation data"); the
 * transcript endpoint — more sensitive, full utterance text — requires the dedicated
 * "channel.voice.transcript.read" permission on top.
 */
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { VoiceSessionListQueryDto, VoiceTranscriptQueryDto } from "./voice-call-history.dto";
import { VoiceCallHistoryService } from "./voice-call-history.service";

function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}

@ApiTags("Voice")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("voice/sessions")
export class VoiceCallHistoryController {
  constructor(private readonly history: VoiceCallHistoryService) {}

  @Get() @RequirePermission("channel.message.read") list(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() query: VoiceSessionListQueryDto
  ) {
    return this.history.list(org(p), query);
  }

  @Get(":id") @RequirePermission("channel.message.read") get(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.history.get(org(p), id);
  }

  @Get(":id/transcript") @RequirePermission("channel.voice.transcript.read") transcript(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: VoiceTranscriptQueryDto
  ) {
    return this.history.transcript(org(p), id, query);
  }
}
