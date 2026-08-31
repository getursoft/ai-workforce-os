import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { RateLimit } from "../security/rate-limit.decorator";
import { CreatePublicLeadDto } from "./platform-lead.dto";
import { PlatformLeadService } from "./platform-lead.service";

/**
 * Public, unauthenticated lead capture from the marketing website ("Book a Demo", "Contact Us", ...) —
 * intentionally has NO auth guard, since a website visitor has no account yet. That makes it a direct
 * target for spam/abuse, so it gets the strict PUBLIC_LEAD_CAPTURE rate limit (mirrors
 * PublicApprovalController's own PUBLIC_APPROVAL_STRICT convention) rather than the global default.
 *
 * Every lead created here is unconditionally `scope: "PLATFORM"` — see PlatformLeadService.create — the
 * caller has no way to influence that (the DTO has no scope/organizationId/ownerId field, and the global
 * ValidationPipe's `forbidNonWhitelisted: true` rejects the request outright if one is present).
 */
@ApiTags("Public Leads")
@RateLimit("PUBLIC_LEAD_CAPTURE")
@Controller("public/leads")
export class PlatformLeadsPublicController {
  constructor(private readonly leads: PlatformLeadService) {}

  @Post()
  async create(@Body() dto: CreatePublicLeadDto) {
    const lead = await this.leads.create({
      source: dto.source,
      name: dto.name,
      email: dto.email,
      phone: dto.phone ?? null,
      company: dto.company ?? null,
      requirement: dto.requirement ?? null,
      preferredDemoDate: dto.preferredDemoDate ?? null,
      preferredDemoTime: dto.preferredDemoTime ?? null,
      timezone: dto.timezone ?? null,
      metadata: dto.metadata ?? {}
    });
    return { data: { id: lead.id, status: lead.status } };
  }
}
