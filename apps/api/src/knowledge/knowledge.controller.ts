import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { KnowledgePageDto, KnowledgeSearchDto } from "./knowledge.dto";
import { KnowledgeSearchService } from "./knowledge.search";
import { KnowledgeService } from "./knowledge.service";
import type { UploadedKnowledgeFile } from "./knowledge.types";
import { Body } from "@nestjs/common";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";

@ApiTags("Knowledge")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("knowledge")
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly searchService: KnowledgeSearchService,
    private readonly audit: AuditEventLogger
  ) {}
  @Post("documents")
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
    @UploadedFile() file?: UploadedKnowledgeFile
  ) {
    return this.knowledge.upload(org(principal), user(principal), request.requestId, file);
  }
  @Get("documents")
  @RequirePermission("knowledge.read")
  list(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: KnowledgePageDto) {
    return this.knowledge.list(org(principal), query);
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
  @Post("search")
  @RequirePermission("knowledge.search")
  async search(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() input: KnowledgeSearchDto
  ) {
    const results = await this.searchService.search(org(principal), input);
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
