import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { AuthenticatedPrincipal } from "../identity/application/ports/authenticated-principal";
import { CurrentPrincipal } from "../identity/presentation/http/current-principal.decorator";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PermissionGuard } from "../identity/presentation/http/permission.guard";
import { RequirePermission } from "../identity/presentation/http/permission.decorators";
import { PlanTripSkillDiagnosticQueryDto } from "./skill-diagnostics.dto";
import { PlanTripSkillDiagnosticsService } from "./plan-trip-skill-diagnostics.service";
import { CreatePlanTripReviewSessionDto } from "./plan-trip-shadow-review.dto";
import { PlanTripShadowReviewService } from "./plan-trip-shadow-review.service";

@ApiTags("Skill diagnostics")
@ApiBearerAuth()
@UseGuards(JwtAccessGuard, PermissionGuard)
@Controller("skills/diagnostics/travel-plan-trip")
export class SkillDiagnosticsController {
  constructor(
    private readonly diagnostics: PlanTripSkillDiagnosticsService,
    private readonly reviews: PlanTripShadowReviewService
  ) {}

  @Get("summary")
  @RequirePermission("agents.executions.read")
  summary(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: PlanTripSkillDiagnosticQueryDto
  ) {
    return this.diagnostics.summary(principal.organizationId.toString(), query);
  }

  @Get("executions/:id")
  @RequirePermission("agents.executions.read")
  execution(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.diagnostics.execution(principal.organizationId.toString(), id);
  }

  @Post("review-sessions")
  @RequirePermission("agents.executions.read")
  createReviewSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() input: CreatePlanTripReviewSessionDto
  ) {
    return this.reviews.createSession(
      principal.organizationId.toString(),
      principal.userId.toString(),
      input
    );
  }

  @Get("review-sessions/:id")
  @RequirePermission("agents.executions.read")
  reviewSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.reviews.getSession(principal.organizationId.toString(), id);
  }

  @Post("review-sessions/:id/start")
  @RequirePermission("agents.executions.read")
  startReviewSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.reviews.startSession(principal.organizationId.toString(), id);
  }

  @Post("review-sessions/:id/complete")
  @RequirePermission("agents.executions.read")
  completeReviewSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.reviews.completeSession(principal.organizationId.toString(), id);
  }

  @Post("review-sessions/:id/archive")
  @RequirePermission("agents.executions.read")
  archiveReviewSession(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.reviews.archiveSession(principal.organizationId.toString(), id);
  }

  @Get("review-sessions/:id/report")
  @RequirePermission("agents.executions.read")
  reviewReport(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("id", new ParseUUIDPipe()) id: string
  ) {
    return this.reviews.report(principal.organizationId.toString(), id);
  }
}
