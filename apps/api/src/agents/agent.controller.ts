import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequireAnyPermission, RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { RateLimit } from "../security/rate-limit.decorator";
import { RateLimitGuard } from "../security/rate-limit.guard";
import { AgentRunDto, PageDto, UpdateConversationDto } from "./agent.dto";
import { AgentService } from "./agent.service";

@ApiTags("Agents")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller()
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly audit: AuditEventLogger
  ) {}
  // Read-only listings — accept the dedicated `agents.read` permission (so a read-only role like
  // "Viewer" can see which AI Employees exist without also being granted execute access) as well as
  // the pre-existing `agents.run` (so any custom, non-system role that already only has `agents.run`
  // keeps working unchanged — DEFAULT_PERMISSIONS re-seeding only syncs the built-in system roles).
  @Get("agents") @RequireAnyPermission("agents.read", "agents.run") employees(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.agents.employees(org(p));
  }
  @Get("agents/tools") @RequireAnyPermission("agents.read", "agents.run") tools() {
    return this.agents.toolCatalog();
  }
  // Sprint 5.0 Phase 9: the global RateLimitGuard already applies AI_EXECUTION per-IP (pre-auth layer);
  // re-applying it here runs after JwtAccessGuard, so this second pass is keyed per-organization instead —
  // a compromised/malicious authenticated account can't flood execution just by having a valid token.
  @Post("agents/run") @RequirePermission("agents.run") @UseGuards(RateLimitGuard) @RateLimit("AI_EXECUTION") async run(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Body() dto: AgentRunDto
  ) {
    this.record("AGENT_EXECUTION_STARTED", req, p);
    try {
      const result = await this.agents.run(org(p), user(p), req.requestId, dto);
      if (!dto.conversationId) this.record("CONVERSATION_CREATED", req, p, result.conversationId);
      this.record(
                   "AGENT_EXECUTION_COMPLETED",
                    req,
                    p,
                    result.executionId ?? undefined
                   );
      return result;
    } catch (error) {
      this.record("AGENT_EXECUTION_FAILED", req, p);
      throw error;
    }
  }
  @Get("conversations") @RequirePermission("agents.conversations.read") conversations(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: PageDto
  ) {
    return this.agents.conversations(org(p), q);
  }
  @Get("conversations/:id") @RequirePermission("agents.conversations.read") conversation(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.agents.conversation(org(p), id);
  }
  @Get("conversations/:id/messages") @RequirePermission("agents.conversations.read") messages(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.agents.messages(org(p), id);
  }
  @Patch("conversations/:id") @RequirePermission("agents.conversations.read") async archive(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateConversationDto
  ) {
    const result = await this.agents.archive(org(p), id, dto.status);
    if (dto.status === "ARCHIVED") this.record("CONVERSATION_ARCHIVED", req, p, id);
    return result;
  }
  @Get("executions") @RequirePermission("agents.executions.read") executions(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: PageDto
  ) {
    return this.agents.executions(org(p), q);
  }
  @Get("executions/:id") @RequirePermission("agents.executions.read") execution(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.agents.execution(org(p), id);
  }
  private record(
    event: string,
    req: IdentityRequest,
    p: AuthenticatedPrincipal,
    targetId?: string
  ) {
    this.audit.record(event, req.requestId, {
      organizationId: org(p),
      userId: user(p),
      ...(targetId ? { targetId } : {})
    });
  }
}
function org(p: AuthenticatedPrincipal) {
  return p.organizationId.toString();
}
function user(p: AuthenticatedPrincipal) {
  return p.userId.toString();
}
