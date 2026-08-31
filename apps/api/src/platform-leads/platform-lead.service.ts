import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, PlatformLead, PlatformLeadSource, PlatformLeadStatus, PlatformLeadType } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";

/**
 * Everything a public lead-capture form can supply. Deliberately has no organizationId/scope/ownerId
 * field at all — a public website visitor is never in a position to assert tenant ownership, and the
 * global ValidationPipe (`whitelist: true, forbidNonWhitelisted: true`, see main.ts) rejects the request
 * outright if the caller tries to smuggle one in via the DTO. `scope` is always PLATFORM, set here, never
 * read from the request.
 */
export interface CreatePlatformLeadInput {
  source: PlatformLeadSource;
  name: string;
  email: string;
  phone?: string | null;
  company?: string | null;
  requirement?: string | null;
  preferredDemoDate?: string | null;
  preferredDemoTime?: string | null;
  timezone?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListPlatformLeadsFilter {
  search?: string;
  source?: PlatformLeadSource;
  status?: PlatformLeadStatus;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface PlatformLeadSummary {
  total: number;
  new: number;
  demoRequests: number;
  contacted: number;
  qualified: number;
  won: number;
}

/** Server-side, never client-supplied — see the doc comment on {@link CreatePlatformLeadInput}. */
function typeForSource(source: PlatformLeadSource): PlatformLeadType {
  switch (source) {
    case "WEBSITE_DEMO":
      return "DEMO_REQUEST";
    case "CONTACT_SALES":
      return "SALES_ENQUIRY";
    case "CONTACT_US":
    case "WEBSITE_ENQUIRY":
      return "GENERAL_ENQUIRY";
    default:
      return "OTHER";
  }
}

/**
 * The single central store for leads generated for Krevia AS A BUSINESS (the platform's own acquisition
 * funnel) — never a tenant organization's own customer leads (those stay in SalesLead/TravelLead/etc,
 * see database/prisma/schema.prisma's PlatformLead doc comment). Every read here is unconditionally
 * scoped to `scope: "PLATFORM"` — there is no parameter or code path that can widen it, so this service
 * can never become a cross-tenant CRM surveillance mechanism no matter what calls it.
 */
@Injectable()
export class PlatformLeadService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreatePlatformLeadInput): Promise<PlatformLead> {
    return this.prisma.platformLead.create({
      data: {
        scope: "PLATFORM",
        source: input.source,
        type: typeForSource(input.source),
        name: input.name.trim(),
        email: input.email.trim().toLowerCase(),
        phone: input.phone?.trim() || null,
        company: input.company?.trim() || null,
        requirement: input.requirement?.trim() || null,
        preferredDemoDate: input.preferredDemoDate?.trim() || null,
        preferredDemoTime: input.preferredDemoTime?.trim() || null,
        timezone: input.timezone?.trim() || null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        status: "NEW"
      }
    });
  }

  async list(filter: ListPlatformLeadsFilter): Promise<{ items: PlatformLead[]; total: number }> {
    const where: Prisma.PlatformLeadWhereInput = { scope: "PLATFORM" };
    if (filter.source) where.source = filter.source;
    if (filter.status) where.status = filter.status;
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lte: filter.to } : {})
      };
    }
    if (filter.search) {
      const search = filter.search.trim();
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
          { company: { contains: search, mode: "insensitive" } },
          { phone: { contains: search, mode: "insensitive" } }
        ];
      }
    }
    const [items, total] = await Promise.all([
      this.prisma.platformLead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: filter.limit ?? 50,
        skip: filter.offset ?? 0
      }),
      this.prisma.platformLead.count({ where })
    ]);
    return { items, total };
  }

  async get(id: string): Promise<PlatformLead> {
    const lead = await this.prisma.platformLead.findFirst({ where: { id, scope: "PLATFORM" } });
    if (!lead) throw new NotFoundException("Lead not found");
    return lead;
  }

  async updateStatus(id: string, status: PlatformLeadStatus): Promise<PlatformLead> {
    // Scoped through the same PLATFORM-only findFirst as `get` — never allows updating anything outside
    // this table's guaranteed PLATFORM-only contents, and 404s (not a Prisma throw) on an unknown id.
    await this.get(id);
    return this.prisma.platformLead.update({ where: { id }, data: { status } });
  }

  async summary(): Promise<PlatformLeadSummary> {
    const where: Prisma.PlatformLeadWhereInput = { scope: "PLATFORM" };
    const [total, byStatus, demoRequests] = await Promise.all([
      this.prisma.platformLead.count({ where }),
      this.prisma.platformLead.groupBy({
        by: ["status"],
        where,
        _count: { _all: true }
      }),
      this.prisma.platformLead.count({ where: { ...where, type: "DEMO_REQUEST" } })
    ]);
    const countFor = (status: PlatformLeadStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    return {
      total,
      new: countFor("NEW"),
      demoRequests,
      contacted: countFor("CONTACTED"),
      qualified: countFor("QUALIFIED"),
      won: countFor("WON")
    };
  }
}
