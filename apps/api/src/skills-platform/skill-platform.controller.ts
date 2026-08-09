import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import type { IdentityRequest } from "../identity/presentation/http/request-context";
import { SkillInstallationService } from "./skill-installation.service";
import {
  SkillAnalyticsQueryDto,
  SkillConfigureDto,
  SkillExecuteDto,
  SkillGrantDto,
  SkillGrantStateDto,
  SkillInstallDto,
  SkillPackInstallDto,
  SkillPageDto,
  SkillPipelineCreateDto,
  SkillPipelineExecuteDto,
  SkillRecommendQueryDto,
  SkillSearchQueryDto,
  SkillTemplateInstallDto,
  SkillVersionUpdateDto
} from "./skill-platform.dto";
import { SkillsRuntimeService } from "./skill-runtime.service";
import { toSkillHttpError } from "./skill-error";
import { SkillRecommendationService } from "./skill-recommendation.service";
import { SkillAnalyticsService } from "./skill-analytics.service";
import { SkillSearchService } from "./skill-search.service";
import { SkillPipelineService } from "./skill-pipeline.service";
import { SkillPackService } from "./skill-pack.service";
import { SkillTemplateService } from "./skill-template.service";

@ApiTags("Skills")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("skills")
export class SkillPlatformController {
  constructor(
    private readonly installations: SkillInstallationService,
    private readonly runtime: SkillsRuntimeService,
    private readonly recommendations: SkillRecommendationService,
    private readonly analytics: SkillAnalyticsService,
    private readonly search: SkillSearchService,
    private readonly pipelines: SkillPipelineService,
    private readonly packs: SkillPackService,
    private readonly templates: SkillTemplateService
  ) {}

  // ------------------------------------------------------------------ marketplace / installations

  @Get("marketplace")
  @RequirePermission("skill.marketplace.read")
  async marketplace(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    try {
      return { data: await this.installations.marketplace(org(principal)) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Get("installations")
  @RequirePermission("skill.marketplace.read")
  async listInstallations(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    try {
      return { data: await this.installations.listInstallations(org(principal)) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Get("installations/:installationId")
  @RequirePermission("skill.marketplace.read")
  async getInstallation(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    try {
      return { data: await this.installations.getInstallation(org(principal), installationId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Post("install")
  @HttpCode(201)
  @RequirePermission("skill.install")
  async install(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: SkillInstallDto
  ) {
    try {
      return {
        data: await this.installations.install(org(principal), user(principal), dto, request.requestId)
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Delete("installations/:installationId")
  @HttpCode(200)
  @RequirePermission("skill.uninstall")
  async uninstall(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    try {
      return {
        data: await this.installations.uninstall(org(principal), user(principal), installationId, request.requestId)
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Patch("installations/:installationId/enable")
  @RequirePermission("skill.update")
  async enable(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    try {
      return {
        data: await this.installations.enable(org(principal), user(principal), installationId, request.requestId)
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Patch("installations/:installationId/disable")
  @RequirePermission("skill.update")
  async disable(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    try {
      return {
        data: await this.installations.disable(org(principal), user(principal), installationId, request.requestId)
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Patch("installations/:installationId/configure")
  @RequirePermission("skill.configure")
  async configure(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string,
    @Body() dto: SkillConfigureDto
  ) {
    try {
      return {
        data: await this.installations.configure(
          org(principal),
          user(principal),
          installationId,
          dto.configuration,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Post("installations/:installationId/update-version")
  @RequirePermission("skill.update")
  async updateVersion(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string,
    @Body() dto: SkillVersionUpdateDto
  ) {
    try {
      return {
        data: await this.installations.updateVersion(
          org(principal),
          user(principal),
          installationId,
          dto.versionConstraint,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Post("installations/:installationId/rollback")
  @RequirePermission("skill.update")
  async rollbackVersion(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    try {
      return {
        data: await this.installations.rollbackVersion(
          org(principal),
          user(principal),
          installationId,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  // ------------------------------------------------------------------ employee grants

  @Get("installations/:installationId/grants")
  @RequirePermission("skill.grant.manage")
  async listGrantsForSkillInstallation(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    return { data: await this.installations.listGrantsForSkillInstallation(org(principal), installationId) };
  }

  @Post("installations/:installationId/grants")
  @HttpCode(201)
  @RequirePermission("skill.grant.manage")
  async grantToEmployee(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string,
    @Body() dto: SkillGrantDto
  ) {
    try {
      return {
        data: await this.installations.grantToEmployee(
          org(principal),
          user(principal),
          dto.pluginInstallationId,
          installationId,
          dto.configurationOverride,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Delete("installations/:installationId/grants/:employeeId")
  @RequirePermission("skill.grant.manage")
  async revokeFromEmployee(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string
  ) {
    try {
      return {
        data: await this.installations.revokeFromEmployee(
          org(principal),
          user(principal),
          employeeId,
          installationId,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Patch("installations/:installationId/grants/:employeeId/state")
  @RequirePermission("skill.grant.manage")
  async setEmployeeGrantEnabled(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("installationId", new ParseUUIDPipe()) installationId: string,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body() dto: SkillGrantStateDto
  ) {
    try {
      return {
        data: await this.installations.setEmployeeGrantEnabled(
          org(principal),
          user(principal),
          employeeId,
          installationId,
          dto.enabled,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  // ------------------------------------------------------------------ execution / discovery / observability

  @Post("execute")
  @RequirePermission("skill.execute")
  async execute(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: SkillExecuteDto
  ) {
    try {
      return {
        data: await this.runtime.execute({
          skillKey: dto.skillKey,
          organizationId: org(principal),
          userId: user(principal),
          input: dto.input ?? {},
          requestId: request.requestId,
          ...(dto.versionConstraint ? { versionConstraint: dto.versionConstraint } : {}),
          ...(dto.pluginInstallationId ? { pluginInstallationId: dto.pluginInstallationId } : {}),
          ...(dto.conversationId ? { conversationId: dto.conversationId } : {}),
          ...(dto.agentExecutionId ? { agentExecutionId: dto.agentExecutionId } : {}),
          ...(dto.workflowExecutionId ? { workflowExecutionId: dto.workflowExecutionId } : {}),
          ...(dto.idempotencyKey ? { idempotencyKey: dto.idempotencyKey } : {})
        })
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  /** Capability discovery (Phase 11): which skills are installed AND granted to this employee. */
  @Get("employees/:employeeId/skills")
  @RequirePermission("skill.execute")
  async skillsForEmployee(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string
  ) {
    return { data: await this.runtime.skillsForEmployee(org(principal), employeeId) };
  }

  @Get("installations/:installationId/executions")
  @RequirePermission("skill.execution.read")
  async executions(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("installationId", new ParseUUIDPipe()) installationId: string,
    @Query() query: SkillPageDto
  ) {
    return {
      data: await this.runtime.executions(org(principal), installationId, {
        page: query.page,
        pageSize: query.pageSize
      })
    };
  }

  @Get("installations/:installationId/health")
  @RequirePermission("skill.health.read")
  async checkHealth(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("installationId", new ParseUUIDPipe()) installationId: string
  ) {
    try {
      return { data: await this.runtime.checkHealth(org(principal), installationId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  // ------------------------------------------------------------------ Sprint 6.1B — search, recommend, analytics

  @Get("search")
  @RequirePermission("skill.marketplace.read")
  async search_(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: SkillSearchQueryDto) {
    return {
      data: await this.search.search(org(principal), {
        ...(query.query ? { query: query.query } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.capability ? { capability: query.capability } : {}),
        ...(query.mimeType ? { mimeType: query.mimeType } : {}),
        ...(query.industry ? { industry: query.industry } : {}),
        ...(query.tag ? { tag: query.tag } : {}),
        ...(query.author ? { author: query.author } : {}),
        ...(query.installed !== undefined ? { installed: query.installed } : {})
      })
    };
  }

  @Get("recommend")
  @RequirePermission("skill.execute")
  async recommend(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: SkillRecommendQueryDto) {
    const uploadedFiles = (query.mimeTypes ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((mimeType) => ({ fileName: "", mimeType }));
    return {
      data: await this.recommendations.recommend(org(principal), {
        ...(query.pluginInstallationId ? { pluginInstallationId: query.pluginInstallationId } : {}),
        ...(query.message ? { message: query.message } : {}),
        ...(query.intent ? { intent: query.intent } : {}),
        ...(query.contentType ? { contentType: query.contentType } : {}),
        ...(uploadedFiles.length > 0 ? { uploadedFiles } : {})
      })
    };
  }

  @Get("analytics")
  @RequirePermission("skill.execution.read")
  async getAnalytics(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: SkillAnalyticsQueryDto) {
    return { data: await this.analytics.getAnalytics(org(principal), this.analyticsFilters(query)) };
  }

  @Get("analytics/export")
  @RequirePermission("skill.execution.read")
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", 'attachment; filename="skill-analytics.csv"')
  async exportAnalytics(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Query() query: SkillAnalyticsQueryDto) {
    return this.analytics.exportCsv(org(principal), this.analyticsFilters(query));
  }

  private analyticsFilters(query: SkillAnalyticsQueryDto) {
    return {
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.skillKey ? { skillKey: query.skillKey } : {}),
      ...(query.pluginInstallationId ? { pluginInstallationId: query.pluginInstallationId } : {})
    };
  }

  // ------------------------------------------------------------------ Sprint 6.1B — pipelines (Skill Chaining Engine)

  @Get("pipelines")
  @RequirePermission("skill.marketplace.read")
  async listPipelines(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { data: await this.pipelines.listPipelines(org(principal)) };
  }

  @Post("pipeline")
  @HttpCode(201)
  @RequirePermission("skill.install")
  async createPipeline(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: SkillPipelineCreateDto
  ) {
    try {
      return { data: await this.pipelines.createPipeline(org(principal), user(principal), dto, request.requestId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Get("pipeline/:pipelineId")
  @RequirePermission("skill.marketplace.read")
  async getPipeline(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("pipelineId", new ParseUUIDPipe()) pipelineId: string
  ) {
    try {
      return { data: await this.pipelines.getPipeline(org(principal), pipelineId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Delete("pipeline/:pipelineId")
  @RequirePermission("skill.uninstall")
  async deletePipeline(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("pipelineId", new ParseUUIDPipe()) pipelineId: string
  ) {
    try {
      return { data: await this.pipelines.deletePipeline(org(principal), user(principal), pipelineId, request.requestId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Post("pipeline/:pipelineId/execute")
  @HttpCode(201)
  @RequirePermission("skill.execute")
  async executePipeline(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("pipelineId", new ParseUUIDPipe()) pipelineId: string,
    @Body() dto: SkillPipelineExecuteDto
  ) {
    try {
      return {
        data: await this.pipelines.execute(
          org(principal),
          user(principal),
          pipelineId,
          {
            input: dto.input ?? {},
            ...(dto.pluginInstallationId ? { pluginInstallationId: dto.pluginInstallationId } : {}),
            ...(dto.conversationId ? { conversationId: dto.conversationId } : {}),
            ...(dto.workflowExecutionId ? { workflowExecutionId: dto.workflowExecutionId } : {})
          },
          null,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Get("pipeline/:pipelineId/executions")
  @RequirePermission("skill.execution.read")
  async listPipelineExecutions(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("pipelineId", new ParseUUIDPipe()) pipelineId: string,
    @Query() query: SkillPageDto
  ) {
    return {
      data: await this.pipelines.listExecutions(org(principal), pipelineId, { page: query.page, pageSize: query.pageSize })
    };
  }

  @Get("pipeline-executions/:executionId")
  @RequirePermission("skill.execution.read")
  async getPipelineExecution(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("executionId", new ParseUUIDPipe()) executionId: string
  ) {
    try {
      return { data: await this.pipelines.getExecution(org(principal), executionId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  // ------------------------------------------------------------------ Sprint 6.1B — packs

  @Get("packs")
  @RequirePermission("skill.marketplace.read")
  async listPacks(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { data: await this.packs.listPacks(org(principal)) };
  }

  @Post("packs/install")
  @HttpCode(201)
  @RequirePermission("skill.install")
  async installPack(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: SkillPackInstallDto
  ) {
    try {
      return {
        data: await this.packs.installPack(
          org(principal),
          user(principal),
          dto.packKey,
          dto.approveSensitivePermissions,
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Post("packs/:packKey/update")
  @RequirePermission("skill.update")
  async updatePack(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("packKey") packKey: string
  ) {
    try {
      return { data: await this.packs.updatePack(org(principal), user(principal), packKey, request.requestId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  @Delete("packs/:packKey")
  @RequirePermission("skill.uninstall")
  async removePack(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Param("packKey") packKey: string
  ) {
    try {
      return { data: await this.packs.removePack(org(principal), user(principal), packKey, request.requestId) };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }

  // ------------------------------------------------------------------ Sprint 6.1B — templates

  @Get("templates")
  @RequirePermission("skill.marketplace.read")
  async listTemplates(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return { data: await this.templates.listTemplates(org(principal)) };
  }

  @Post("templates/install")
  @HttpCode(201)
  @RequirePermission("skill.install")
  async installTemplate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: IdentityRequest,
    @Body() dto: SkillTemplateInstallDto
  ) {
    try {
      return {
        data: await this.templates.installTemplate(
          org(principal),
          user(principal),
          dto.templateKey,
          {
            ...(dto.pluginInstallationId ? { pluginInstallationId: dto.pluginInstallationId } : {}),
            ...(dto.approveSensitivePermissions !== undefined
              ? { approveSensitivePermissions: dto.approveSensitivePermissions }
              : {})
          },
          request.requestId
        )
      };
    } catch (error) {
      throw toSkillHttpError(error);
    }
  }
}

function org(principal: AuthenticatedPrincipal): string {
  return principal.organizationId.toString();
}

function user(principal: AuthenticatedPrincipal): string {
  return principal.userId.toString();
}
