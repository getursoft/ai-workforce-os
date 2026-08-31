import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { PlatformLeadSource, PlatformLeadStatus } from "@prisma/client";
import { JwtAccessGuard } from "../identity/presentation/http/jwt-access.guard";
import { PlatformOwnerGuard } from "../identity/infrastructure/security/platform-owner.guard";
import { RateLimit } from "../security/rate-limit.decorator";
import { UpdatePlatformLeadStatusDto } from "./platform-lead.dto";
import { PlatformLeadService } from "./platform-lead.service";

const VALID_SOURCES = new Set(["WEBSITE_DEMO", "CONTACT_SALES", "CONTACT_US", "WEBSITE_ENQUIRY", "OTHER"]);
const VALID_STATUSES = new Set(["NEW", "CONTACTED", "QUALIFIED", "DEMO_SCHEDULED", "WON", "LOST"]);

/**
 * Platform Owner console: leads generated for Krevia itself (never a tenant's own customer leads — see
 * PlatformLeadService's doc comment). Every route is guarded by PlatformOwnerGuard — the SAME guard
 * PlatformController already uses for /platform/organizations — so this reuses the existing
 * platform-owner authorization architecture rather than any new/ad hoc check. Normal OWNER/ADMIN/MEMBER
 * users of any organization, including their own, get a 403 (ForbiddenException("PLATFORM_OWNER_ONLY"))
 * even if they know the URL.
 */
@ApiTags("Platform Sales Leads")
@ApiBearerAuth()
@Controller("platform/sales-leads")
@UseGuards(JwtAccessGuard, PlatformOwnerGuard)
@RateLimit("ADMIN_API")
export class PlatformLeadsController {
  constructor(private readonly leads: PlatformLeadService) {}

  @Get()
  async list(
    @Query("search") search?: string,
    @Query("source") source?: string,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string
  ) {
    const result = await this.leads.list({
      ...(search ? { search } : {}),
      ...(source && VALID_SOURCES.has(source) ? { source: source as PlatformLeadSource } : {}),
      ...(status && VALID_STATUSES.has(status) ? { status: status as PlatformLeadStatus } : {}),
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: new Date(to) } : {}),
      limit: limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50,
      offset: offset ? Math.max(0, parseInt(offset, 10) || 0) : 0
    });
    return { data: result };
  }

  @Get("summary")
  async summary() {
    return { data: await this.leads.summary() };
  }

  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    return { data: await this.leads.get(id) };
  }

  @Patch(":id/status")
  async updateStatus(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdatePlatformLeadStatusDto) {
    return { data: await this.leads.updateStatus(id, dto.status) };
  }
}
