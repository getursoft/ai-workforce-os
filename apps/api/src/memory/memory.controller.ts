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
  MemoryAuditQueryDto,
  MemoryCreateDto,
  MemoryForgetDto,
  MemoryListQueryDto,
  MemoryMergeDto,
  MemoryRecallDto,
  MemorySearchDto,
  MemorySummarizeDto,
  MemoryUpdateDto,
  MemoryExpireDto
} from "./memory.dto";
import { MemoryService } from "./memory.service";

/**
 * Sprint 4.5 Memory REST API. Every route is tenant-aware (org comes from the authenticated principal)
 * and RBAC-protected (`agents.memory.read` for reads, `agents.memory.write` for writes). Read routes
 * also write an audit event so memory access is traceable.
 */
@ApiTags("Memory")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("memory")
export class MemoryController {
  constructor(
    private readonly memories: MemoryService,
    private readonly audit: AuditEventLogger
  ) {}

  @Get()
  @RequirePermission("agents.memory.read")
  list(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: MemoryListQueryDto) {
    return this.memories.list(
      org(principal),
      user(principal),
      {
        organizationId: org(principal),
        scope: query.scope ?? null,
        category: query.category ?? null,
        key: query.key ?? null,
        employeeId: query.employeeId ?? null,
        userId: query.userId ?? null,
        conversationId: query.conversationId ?? null,
        importance: query.importance ?? null,
        source: query.source ?? null,
        includeDeleted: query.includeDeleted ?? false
      },
      { page: query.page, pageSize: query.pageSize }
    );
  }

  @Post()
  @RequirePermission("agents.memory.write")
  async remember(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: MemoryCreateDto
  ) {
    const result = await this.memories.remember(
      {
        organizationId: org(principal),
        scope: dto.scope,
        key: dto.key,
        category: dto.category ?? "GENERAL",
        value: dto.value,
        employeeId: dto.employeeId ?? null,
        userId: dto.scope === "USER" ? dto.userId ?? user(principal) : dto.userId ?? null,
        conversationId: dto.conversationId ?? null,
        confidence: dto.confidence,
        importance: dto.importance,
        source: dto.source,
        searchableText: dto.searchableText,
        metadata: dto.metadata,
        expiresAt: dto.expiresAt,
        actorId: user(principal)
      }
    );
    this.record(request, "MEMORY_CREATED", principal, result.id);
    return result;
  }

  @Patch(":id")
  @RequirePermission("agents.memory.write")
  async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: MemoryUpdateDto
  ) {
    const result = await this.memories.update(org(principal), id, dto, user(principal));
    this.record(request, "MEMORY_UPDATED", principal, id);
    return result;
  }

  @Delete(":id")
  @RequirePermission("agents.memory.write")
  @HttpCode(204)
  async forget(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    await this.memories.forget(org(principal), id, user(principal));
    this.record(request, "MEMORY_DELETED", principal, id);
  }

  @Post("search")
  @RequirePermission("agents.memory.read")
  async search(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: MemorySearchDto
  ) {
    const results = await this.memories.search(
      org(principal),
      {
        userId: user(principal),
        employeeId: dto.employeeId ?? null,
        conversationId: dto.conversationId ?? null
      },
      {
        query: dto.query,
        employeeId: dto.employeeId ?? null,
        conversationId: dto.conversationId ?? null,
        limit: dto.limit,
        minScore: dto.minScore,
        semantic: dto.semantic,
        scope: dto.scope ?? undefined
      }
    );
    this.record(request, "MEMORY_SEARCHED", principal);
    return results;
  }

  @Post("recall")
  @RequirePermission("agents.memory.read")
  async recall(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: MemoryRecallDto
  ) {
    const context = await this.memories.recall(org(principal), {
      userId: user(principal),
      employeeId: dto.employeeId ?? null,
      conversationId: dto.conversationId ?? null
    });
    return {
      organization: context.organization,
      employee: context.employee,
      user: context.user,
      conversationSummary: context.conversationSummary
    };
  }

  @Post("summarize")
  @RequirePermission("agents.memory.write")
  async summarize(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: MemorySummarizeDto
  ) {
    const result = await this.memories.summarizeConversation(
      org(principal),
      dto.conversationId,
      user(principal)
    );
    this.record(request, "MEMORY_SUMMARIZED", principal, dto.conversationId);
    return result;
  }

  @Post("forget")
  @RequirePermission("agents.memory.write")
  async forgetCriteria(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: MemoryForgetDto
  ) {
    const result = await this.memories.forgetByCriteria(
      org(principal),
      {
        organizationId: org(principal),
        scope: dto.scope ?? null,
        category: dto.category ?? null,
        key: dto.key ?? null,
        employeeId: dto.employeeId ?? null,
        conversationId: dto.conversationId ?? null
      },
      user(principal)
    );
    this.record(request, "MEMORY_FORGOTTEN", principal);
    return result;
  }

  @Post("merge")
  @RequirePermission("agents.memory.write")
  async merge(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: MemoryMergeDto
  ) {
    const result = await this.memories.merge(org(principal), dto.ids, user(principal));
    this.record(request, "MEMORY_MERGED", principal, result.survivor.id);
    return result;
  }

  @Post("expire")
  @RequirePermission("agents.memory.write")
  async expire(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: MemoryExpireDto
  ) {
    const count = await this.memories.expire(org(principal), dto.scope ?? undefined);
    this.record(request, "MEMORY_EXPIRED", principal);
    return { expired: count };
  }

  @Get("audit")
  @RequirePermission("agents.memory.read")
  async auditTrail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: MemoryAuditQueryDto
  ) {
    const result = await this.memories.listAuditEvents(org(principal), {
      memoryId: query.memoryId,
      scope: query.scope,
      page: query.page,
      pageSize: query.pageSize
    });
    return {
      items: result.items,
      pagination: paged(query.page, query.pageSize, result.total)
    };
  }

  private record(
    request: IdentityRequest,
    event: string,
    principal: AuthenticatedPrincipal,
    targetId?: string
  ) {
    this.audit.record(event, request.requestId, {
      organizationId: org(principal),
      userId: user(principal),
      ...(targetId ? { targetId } : {})
    });
  }
}

function org(principal: AuthenticatedPrincipal) {
  return principal.organizationId.toString();
}
function user(principal: AuthenticatedPrincipal) {
  return principal.userId.toString();
}
function paged(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
