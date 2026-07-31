import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import {
  AgentRunDto,
  PageDto,
  SaveMemoryDto,
  SearchMemoryDto,
  UpdateConversationDto,
  UpdateMemoryDto
} from "./agent.dto";
import { AgentService, MemoryService } from "./agent.service";

@ApiTags("Agents")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller()
export class AgentController {
  constructor(
    private readonly agents: AgentService,
    private readonly memories: MemoryService,
    private readonly audit: AuditEventLogger
  ) {}
  @Get("agents") @RequirePermission("agents.run") employees(
    @CurrentPrincipal() p: AuthenticatedPrincipal
  ) {
    return this.agents.employees(org(p));
  }
  @Get("agents/tools") @RequirePermission("agents.run") tools() {
    return this.agents.toolCatalog();
  }
  @Post("agents/run") @RequirePermission("agents.run") async run(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Body() dto: AgentRunDto
  ) {
    this.record("AGENT_EXECUTION_STARTED", req, p);
    try {
      const result = await this.agents.run(org(p), user(p), req.requestId, dto);
      if (!dto.conversationId) this.record("CONVERSATION_CREATED", req, p, result.conversationId);
      this.record("AGENT_EXECUTION_COMPLETED", req, p, result.executionId);
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
  @Get("memory") @RequirePermission("agents.memory.read") memory(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Query() q: PageDto
  ) {
    return this.memories.list(org(p), user(p), q);
  }
  @Post("memory") @RequirePermission("agents.memory.write") async save(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Body() dto: SaveMemoryDto
  ) {
    const result = await this.memories.save(org(p), user(p), dto);
    this.record("MEMORY_CREATED", req, p, result.id);
    return result;
  }
  @Post("memory/search") @RequirePermission("agents.memory.read") search(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Body() dto: SearchMemoryDto
  ) {
    return this.memories.search(org(p), user(p), dto);
  }
  @Patch("memory/:id") @RequirePermission("agents.memory.write") async updateMemory(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMemoryDto
  ) {
    const result = await this.memories.update(org(p), user(p), id, dto);
    this.record("MEMORY_UPDATED", req, p, id);
    return result;
  }
  @Delete("memory/:id") @RequirePermission("agents.memory.write") @HttpCode(204) async forget(
    @CurrentPrincipal() p: AuthenticatedPrincipal,
    @Req() req: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    await this.memories.forget(org(p), user(p), id);
    this.record("MEMORY_DELETED", req, p, id);
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
