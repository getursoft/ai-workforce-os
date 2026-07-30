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
  UploadedFile,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { KnowledgeCollectionService } from "./knowledge.collection";
import {
  KnowledgeCollectionCreateDto,
  KnowledgeCollectionUpdateDto,
  KnowledgePageDto,
  KnowledgeSearchDto
} from "./knowledge.dto";
import { KnowledgeSearchService } from "./knowledge.search";
import { KnowledgeService } from "./knowledge.service";
import type { UploadedKnowledgeFile } from "./knowledge.types";

/**
 * Every knowledge write/read/search route is nested under an AI Employee (Plugin installation) id —
 * "AI Employee owns its own knowledge collection" is enforced structurally here, not just in the
 * service layer: there is no route that can list or search knowledge without naming the employee.
 * `/knowledge/documents/:id` stays flat because a document id alone is already unambiguous once
 * issued (it belongs to exactly one collection/employee, verified in KnowledgeService).
 */
@ApiTags("Knowledge")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("knowledge")
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly collections: KnowledgeCollectionService,
    private readonly searchService: KnowledgeSearchService,
    private readonly audit: AuditEventLogger
  ) {}

  @Post("employees/:employeeId/collections")
  @RequirePermission("knowledge.collection.manage")
  createCollection(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body() dto: KnowledgeCollectionCreateDto
  ) {
    return this.collections.create(
      org(principal),
      employeeId,
      request.requestId,
      user(principal),
      dto
    );
  }
  @Get("employees/:employeeId/collections")
  @RequirePermission("knowledge.read")
  listCollections(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string
  ) {
    return this.collections.list(org(principal), employeeId);
  }
  @Patch("collections/:id")
  @RequirePermission("knowledge.collection.manage")
  updateCollection(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: KnowledgeCollectionUpdateDto
  ) {
    return this.collections.update(org(principal), id, dto);
  }
  @Delete("collections/:id")
  @RequirePermission("knowledge.collection.manage")
  @HttpCode(204)
  removeCollection(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.collections.remove(org(principal), request.requestId, user(principal), id);
  }

  @Post("employees/:employeeId/collections/:collectionId/documents")
  @RequirePermission("knowledge.upload")
  @UseInterceptors(FileInterceptor("file"))
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } }
    }
  })
  upload(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Param("collectionId", new ParseUUIDPipe()) collectionId: string,
    @UploadedFile() file?: UploadedKnowledgeFile
  ) {
    return this.knowledge.upload(
      org(principal),
      employeeId,
      collectionId,
      user(principal),
      request.requestId,
      file
    );
  }
  @Get("employees/:employeeId/documents")
  @RequirePermission("knowledge.read")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Query() query: KnowledgePageDto
  ) {
    return this.knowledge.list(org(principal), employeeId, query);
  }
  @Get("documents/:id")
  @RequirePermission("knowledge.read")
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    return this.knowledge.get(
      org(principal),
      id,
      bounded(page, 1, 10_000, 1),
      bounded(pageSize, 1, 100, 20)
    );
  }
  @Post("documents/:id/reindex")
  @RequirePermission("knowledge.reindex")
  reindex(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.knowledge.reindex(org(principal), id);
  }
  @Delete("documents/:id")
  @RequirePermission("knowledge.delete")
  @HttpCode(204)
  remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.knowledge.remove(org(principal), user(principal), request.requestId, id);
  }
  @Post("employees/:employeeId/search")
  @RequirePermission("knowledge.search")
  async search(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body() input: KnowledgeSearchDto
  ) {
    const results = await this.searchService.search(org(principal), employeeId, input);
    this.audit.record("KNOWLEDGE_SEARCHED", request.requestId, {
      organizationId: org(principal),
      userId: user(principal)
    });
    return results;
  }
}
function org(principal: AuthenticatedPrincipal) {
  return principal.organizationId.toString();
}
function user(principal: AuthenticatedPrincipal) {
  return principal.userId.toString();
}
function bounded(value: string | undefined, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
