import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnprocessableEntityException
} from "@nestjs/common";
import { EntitlementService } from "../entitlements/entitlement.service";
import { PluginStatus, Prisma } from "@prisma/client";
import { DummyEchoPlugin } from "@ai-workforce-os/plugin-dummy";
import {
  PluginHealthStatus,
  PluginPermission,
  type PluginContext,
  type PluginManifest
} from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { IdentityApplicationError } from "../identity/application/errors/identity.error";
import {
  ConfigurationSchemaValidator,
  ManifestValidator,
  type EncryptedPayload,
  PluginRegistry,
  PluginDiscovery,
  PluginLifecycleEngine,
  createPluginServices,
  type DiscoveredPlugin,
  PluginSecretsEncryptionService,
  PluginValidationError
} from "./plugin.runtime";
import type {
  InstallPluginDto,
  PluginQueryDto,
  UpdatePluginConfigurationDto,
  UpdatePluginGrantsDto,
  UpdatePluginDto
} from "./plugin.dto";

@Injectable()
export class PluginService implements OnModuleInit {
  private catalog = new Map<string, DiscoveredPlugin>();
  private discoveryErrors: readonly { plugin: string; code: string; details: readonly string[] }[] =
    [];
  constructor(
    private readonly prisma: PrismaService,
    private readonly manifests: ManifestValidator,
    private readonly schemas: ConfigurationSchemaValidator,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly registry: PluginRegistry,
    private readonly discovery: PluginDiscovery,
    private readonly lifecycle: PluginLifecycleEngine,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig,
    @Optional() private readonly entitlements?: EntitlementService
  ) {}

  async onModuleInit(): Promise<void> {
    const discovered = await this.discovery.discover();
    this.catalog = new Map(
      discovered.plugins
        .filter(
          (plugin) =>
            this.security.allowDevelopmentImplementations || plugin.manifest.id !== "dummy-echo"
        )
        .map((plugin) => [plugin.manifest.id, plugin])
    );
    this.discoveryErrors = discovered.errors;
    await this.synchronizeRegistry();
    await this.checkRoutingProfilesAtStartup();
  }

  private async checkRoutingProfilesAtStartup(): Promise<void> {
    try {
      const plugins = await this.prisma.plugin.findMany({ where: { deletedAt: null } });
      for (const plugin of plugins) {
        const existing = await this.prisma.employeeRoutingProfile.findUnique({ where: { pluginInstallationId: plugin.id } });
        if (!existing) {
          await this.ensureRoutingProfile(plugin, "STARTUP");
        }
      }
    } catch (error) {
      this.logger.warn({ event: "RoutingProfileStartupCheckFailed", error: String(error) });
    }
  }

  async available(organizationId: string) {
    const installed = new Set(
      (
        await this.prisma.plugin.findMany({
          where: { organizationId, deletedAt: null },
          select: { slug: true }
        })
      ).map((plugin) => plugin.slug)
    );
    return {
      items: [...this.catalog.values()].map(({ manifest }) => ({
        ...this.publicManifest(manifest),
        installed: installed.has(manifest.id)
      })),
      errors: this.discoveryErrors
    };
  }

  async install(organizationId: string, userId: string, dto: InstallPluginDto) {
    // Sprint 5.0 Phase 11: the one place every AI Employee installation goes through, regardless of
    // which employee/plugin — the natural checkpoint for the "maximum installed employees" entitlement.
    if (this.entitlements) await this.entitlements.consumeCapacity(organizationId, "MAX_EMPLOYEES");
    if (dto.pluginId === "dummy-echo" && !this.security.allowDevelopmentImplementations)
      throw new IdentityApplicationError(
        "DEVELOPMENT_PLUGIN_NOT_ALLOWED",
        "Development plugins are not allowed in this environment."
      );
    const discovered = dto.pluginId ? this.catalog.get(dto.pluginId) : undefined;
    if (dto.pluginId && !discovered) throw new NotFoundException("PLUGIN_NOT_FOUND");
    if (!dto.manifest && !discovered)
      throw new UnprocessableEntityException("pluginId is required");
    const manifest = discovered?.manifest ?? this.validateManifest(dto.manifest);
    const granted = dto.grantedPermissions ?? manifest.permissions;
    if (granted.some((permission) => !manifest.permissions.includes(permission)))
      throw new UnprocessableEntityException("Granted permissions must be declared by the plugin");
    const config = dto.configuration?.config ?? {};
    this.validateConfig(`${organizationId}:${manifest.id}`, manifest, config);
    const encrypted = this.secrets.encrypt(dto.configuration?.secrets ?? {});
    try {
      return await this.prisma.$transaction(async (tx) => {
        const plugin = await tx.plugin.create({
          data: {
            organizationId,
            name: manifest.name,
            slug: manifest.id,
            version: manifest.version,
            displayName: manifest.displayName,
            description: manifest.description,
            author: manifest.author,
            entryPoint: manifest.entryPoint,
            manifest: manifest as unknown as Prisma.InputJsonValue,
            configSchema: manifest.configSchema
              ? (manifest.configSchema as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            grantedPermissions: granted as unknown as Prisma.InputJsonValue,
            configuration: {
              create: {
                organizationId,
                config: config as Prisma.InputJsonValue,
                encryptedSecrets: encrypted as unknown as Prisma.InputJsonValue,
                updatedBy: userId
              }
            }
          }
        });
        const instance = discovered?.create() ?? this.adapter(manifest.entryPoint),
          context = this.context(plugin, userId, config, manifest, granted);
        try {
          await this.lifecycle.install(instance, context);
        } catch (error) {
          await tx.plugin.update({
            where: { id: plugin.id },
            data: {
              status: PluginStatus.FAILED,
              lastErrorCode: error instanceof Error ? error.message : "PLUGIN_LIFECYCLE_FAILED",
              lastErrorMessage: "Plugin install hook failed"
            }
          });
          throw new ConflictException("PLUGIN_LIFECYCLE_FAILED");
        }
        if (dto.enable) {
          await this.lifecycle.enable(instance, context);
          await tx.plugin.update({
            where: { id: plugin.id },
            data: { status: PluginStatus.ACTIVE, enabledAt: new Date(), lastStartedAt: new Date() }
          });
          this.registry.register(organizationId, plugin.slug, instance);
        }
        await this.ensureRoutingProfile(plugin, "INSTALLATION", tx);
        return this.sanitize(await tx.plugin.findUniqueOrThrow({ where: { id: plugin.id } }));
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("PLUGIN_ALREADY_INSTALLED");
      throw error;
    }
  }

  async list(organizationId: string, query: PluginQueryDto) {
    const where: Prisma.PluginWhereInput = {
      organizationId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: ["name", "displayName", "slug", "author"].map((field) => ({
              [field]: { contains: query.search, mode: "insensitive" }
            }))
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.plugin.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.plugin.count({ where })
    ]);
    return {
      items: items.map((x) => this.sanitize(x)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        pages: Math.ceil(total / query.pageSize)
      }
    };
  }
  async get(organizationId: string, id: string) {
    return this.sanitize(await this.require(organizationId, id));
  }

  async update(organizationId: string, id: string, dto: UpdatePluginDto) {
    const current = await this.require(organizationId, id);
    let manifest = current.manifest as unknown as PluginManifest;
    if (dto.manifest) {
      manifest = this.validateManifest(dto.manifest);
      if (manifest.id !== current.slug) throw new ConflictException("PLUGIN_SLUG_CONFLICT");
      this.schemas.invalidate(`${organizationId}:${current.slug}`);
    }
    const updated = await this.prisma.plugin.update({
      where: { id },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.manifest
          ? {
              version: manifest.version,
              manifest: manifest as unknown as Prisma.InputJsonValue,
              configSchema: manifest.configSchema
                ? (manifest.configSchema as Prisma.InputJsonValue)
                : Prisma.JsonNull
            }
          : {})
      }
    });
    return this.sanitize(updated);
  }
  async updateGrants(organizationId: string, id: string, dto: UpdatePluginGrantsDto) {
    const plugin = await this.require(organizationId, id);
    const manifest = plugin.manifest as unknown as PluginManifest;
    const declared = new Set<string>([...manifest.permissions, ...(manifest.capabilities ?? [])]);
    if (dto.grantedPermissions.some((permission) => !declared.has(permission)))
      throw new UnprocessableEntityException("Granted permissions must be declared by the plugin");
    return this.sanitize(
      await this.prisma.plugin.update({
        where: { id },
        data: {
          grantedPermissions: [
            ...new Set(dto.grantedPermissions)
          ] as unknown as Prisma.InputJsonValue
        }
      })
    );
  }
  async canManageGrants(organizationId: string, userId: string): Promise<boolean> {
    return (
      (await this.prisma.userRole.count({
        where: {
          userId,
          user: { organizationId, status: "ACTIVE", deletedAt: null },
          role: { organizationId, isSystem: true, name: { in: ["Owner", "Admin"] } }
        }
      })) > 0
    );
  }
  async enable(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
    if (plugin.status === PluginStatus.ACTIVE) return this.sanitize(plugin);
    if (plugin.status === PluginStatus.DEPRECATED) throw new ConflictException("PLUGIN_DEPRECATED");
    const instance = this.catalog.get(plugin.slug)?.create() ?? this.adapter(plugin.entryPoint),
      context = await this.contextFor(plugin);
    try {
      await this.lifecycle.enable(instance, context);
    } catch {
      await this.prisma.plugin.update({
        where: { id },
        data: {
          status: PluginStatus.FAILED,
          lastErrorCode: "PLUGIN_LIFECYCLE_FAILED",
          lastErrorMessage: "Plugin enable hook failed"
        }
      });
      throw new ConflictException("PLUGIN_LIFECYCLE_FAILED");
    }
    if (!this.registry.has(organizationId, plugin.slug))
      this.registry.register(organizationId, plugin.slug, instance);
    return this.sanitize(
      await this.prisma.plugin.update({
        where: { id },
        data: {
          status: PluginStatus.ACTIVE,
          enabledAt: new Date(),
          lastStartedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null
        }
      })
    );
  }
  async disable(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
    if (plugin.status === PluginStatus.DISABLED) return this.sanitize(plugin);
    const instance =
      this.registry.lookup(organizationId, plugin.slug) ??
      this.catalog.get(plugin.slug)?.create() ??
      this.adapter(plugin.entryPoint);
    try {
      await this.lifecycle.disable(instance, await this.contextFor(plugin));
    } catch {
      await this.prisma.plugin.update({
        where: { id },
        data: {
          status: PluginStatus.FAILED,
          lastErrorCode: "PLUGIN_LIFECYCLE_FAILED",
          lastErrorMessage: "Plugin disable hook failed"
        }
      });
      throw new ConflictException("PLUGIN_LIFECYCLE_FAILED");
    }
    this.registry.unregister(organizationId, plugin.slug);
    return this.sanitize(
      await this.prisma.plugin.update({
        where: { id },
        data: {
          status: PluginStatus.DISABLED,
          disabledAt: new Date(),
          lastStoppedAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null
        }
      })
    );
  }
  async remove(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
    const instance =
      this.registry.lookup(organizationId, plugin.slug) ??
      this.catalog.get(plugin.slug)?.create() ??
      this.adapter(plugin.entryPoint);
    try {
      await this.lifecycle.uninstall(instance, await this.contextFor(plugin));
    } catch {
      throw new ConflictException("PLUGIN_LIFECYCLE_FAILED");
    }
    this.registry.unregister(organizationId, plugin.slug);
    await this.prisma.plugin.update({
      where: { id },
      data: { deletedAt: new Date(), status: PluginStatus.DISABLED }
    });
  }

  async configuration(organizationId: string, id: string) {
    await this.require(organizationId, id);
    const row = await this.prisma.pluginConfiguration.findFirst({
      where: { organizationId, pluginId: id }
    });
    if (!row) throw new NotFoundException();
    const secretKeys = Object.keys(
      this.secrets.decrypt(row.encryptedSecrets as unknown as EncryptedPayload)
    );
    return { pluginId: id, config: row.config, secretKeys, updatedAt: row.updatedAt };
  }
  async updateConfiguration(
    organizationId: string,
    userId: string,
    id: string,
    dto: UpdatePluginConfigurationDto
  ) {
    const plugin = await this.require(organizationId, id),
      row = await this.prisma.pluginConfiguration.findFirst({
        where: { organizationId, pluginId: id }
      });
    if (!row) throw new NotFoundException();
    const config = dto.config ?? (row.config as Record<string, unknown>);
    this.validateConfig(
      `${organizationId}:${plugin.slug}`,
      plugin.manifest as unknown as PluginManifest,
      config
    );
    const removals = new Set(
      Object.entries(dto.secrets ?? {})
        .filter(([, value]) => value === null)
        .map(([key]) => key)
    );
    const merged = Object.fromEntries(
      Object.entries(
        this.secrets.decrypt(row.encryptedSecrets as unknown as EncryptedPayload)
      ).filter(([key]) => !removals.has(key))
    );
    for (const [key, value] of Object.entries(dto.secrets ?? {})) {
      if (value !== null) merged[key] = value;
    }
    const updated = await this.prisma.pluginConfiguration.update({
      where: { id: row.id },
      data: {
        config: config as Prisma.InputJsonValue,
        encryptedSecrets: this.secrets.encrypt(merged) as unknown as Prisma.InputJsonValue,
        updatedBy: userId
      }
    });
    return {
      pluginId: id,
      config: updated.config,
      secretKeys: Object.keys(merged),
      updatedAt: updated.updatedAt
    };
  }
  async health(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
    if (plugin.status !== PluginStatus.ACTIVE)
      return { status: PluginHealthStatus.DISABLED, checkedAt: new Date().toISOString() };
    const instance = this.registry.lookup(organizationId, plugin.slug);
    if (!instance)
      return { status: PluginHealthStatus.UNKNOWN, checkedAt: new Date().toISOString() };
    let result;
    try {
      result = await this.lifecycle.health(instance, await this.contextFor(plugin));
    } catch {
      result = {
        status: PluginHealthStatus.FAILED,
        checkedAt: new Date().toISOString(),
        message: "Health check failed"
      };
    }
    await this.prisma.plugin.update({
      where: { id },
      data: { lastHealthStatus: result.status, lastHealthCheckedAt: new Date() }
    });
    return result;
  }
  async synchronizeRegistry(): Promise<void> {
    const plugins = await this.prisma.plugin.findMany({
      where: { status: PluginStatus.ACTIVE, deletedAt: null }
    });
    for (const plugin of plugins) {
      try {
        this.validateManifest(plugin.manifest);
        if (!this.registry.has(plugin.organizationId, plugin.slug))
          this.registry.register(
            plugin.organizationId,
            plugin.slug,
            this.catalog.get(plugin.slug)?.create() ?? this.adapter(plugin.entryPoint)
          );
      } catch {
        /* one invalid installation must not stop startup */
      }
    }
  }
  private adapter(entryPoint: string) {
    if (entryPoint === "dummy-echo" && this.security.allowDevelopmentImplementations)
      return new DummyEchoPlugin();
    throw new ConflictException("PLUGIN_REGISTRATION_FAILED");
  }
  private async require(organizationId: string, id: string) {
    const plugin = await this.prisma.plugin.findFirst({
      where: { id, organizationId, deletedAt: null }
    });
    if (!plugin) throw new NotFoundException();
    return plugin;
  }
  private validateManifest(value: unknown) {
    try {
      return this.manifests.validate(value);
    } catch (error) {
      if (error instanceof PluginValidationError)
        throw new UnprocessableEntityException(error.details);
      throw error;
    }
  }
  private validateConfig(key: string, manifest: PluginManifest, config: unknown) {
    try {
      this.schemas.validate(key, manifest.configSchema, config);
    } catch (error) {
      if (error instanceof PluginValidationError)
        throw new UnprocessableEntityException(error.details);
      throw error;
    }
  }
  private sanitize<T extends { manifest: unknown; configSchema: unknown }>(plugin: T) {
    return { ...plugin, manifest: this.publicManifest(plugin.manifest as PluginManifest) };
  }
  private publicManifest(manifest: PluginManifest) {
    return {
      id: manifest.id,
      name: manifest.name,
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      author: manifest.author,
      permissions: manifest.permissions,
      capabilities: manifest.capabilities ?? [],
      tools: manifest.tools,
      configSchema: this.publicSchema(manifest.configSchema)
    };
  }
  private publicSchema(schema: Record<string, unknown> | undefined) {
    if (!schema) return undefined;
    const clone = structuredClone(schema);
    if (typeof clone.properties === "object" && clone.properties !== null)
      for (const value of Object.values(clone.properties as Record<string, unknown>)) {
        if (
          typeof value === "object" &&
          value !== null &&
          ((value as { writeOnly?: unknown }).writeOnly === true ||
            (value as { format?: unknown }).format === "password")
        )
          Reflect.deleteProperty(value, "default");
      }
    return clone;
  }
  private context<T extends { id: string; organizationId: string; grantedPermissions: unknown }>(
    plugin: T,
    userId: string | undefined,
    config: Record<string, unknown>,
    manifest: PluginManifest,
    grantedInput?: PluginPermission[]
  ): PluginContext {
    const granted = new Set(grantedInput ?? (plugin.grantedPermissions as PluginPermission[]));
    return {
      organizationId: plugin.organizationId,
      ...(userId ? { actorUserId: userId } : {}),
      installationId: plugin.id,
      requestId: plugin.id,
      manifest,
      config: Object.freeze({ ...config }),
      permissions: granted,
      services: createPluginServices(granted),
      logger: { debug() {}, info() {}, warn() {}, error() {} }
    };
  }
  private async contextFor(
    plugin: Awaited<ReturnType<PluginService["require"]>>
  ): Promise<PluginContext> {
    const configuration = await this.prisma.pluginConfiguration.findUnique({
      where: { pluginId: plugin.id }
    });
    return this.context(
      plugin,
      undefined,
      (configuration?.config ?? {}) as Record<string, unknown>,
      plugin.manifest as unknown as PluginManifest
    );
  }

  private readonly logger = new Logger(PluginService.name);

  // ---- EmployeeRoutingProfile lifecycle ----

  private async ensureRoutingProfile(
    plugin: { id: string; organizationId: string; slug: string; displayName: string; description: string; manifest: unknown },
    source: "INSTALLATION" | "STARTUP" | "BACKFILL",
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const prisma = tx ?? this.prisma;
    const existing = await (prisma as typeof this.prisma).employeeRoutingProfile.findUnique({ where: { pluginInstallationId: plugin.id } });
    if (existing) {
      this.logger.log({ event: "RoutingProfileAlreadyExists", employeeInstallationId: plugin.id, organizationId: plugin.organizationId, source });
      return;
    }
    const manifest = (plugin.manifest as Record<string, unknown>) ?? {};
    const routing = manifest.routing as Record<string, unknown> | undefined;
    const defaults = this.defaultRoutingProfile(plugin);
    try {
      await (prisma as typeof this.prisma).employeeRoutingProfile.create({
        data: {
          organizationId: plugin.organizationId,
          pluginInstallationId: plugin.id,
          displayName: (routing?.displayName as string) ?? defaults.displayName,
          employeeType: (routing?.employeeType as string) ?? defaults.employeeType,
          summary: (routing?.summary as string) ?? defaults.summary,
          supportedDomains: (routing?.supportedDomains ?? defaults.supportedDomains) as unknown as Prisma.InputJsonValue,
          supportedIntents: (routing?.supportedIntents ?? defaults.supportedIntents) as unknown as Prisma.InputJsonValue,
          exampleQueries: (routing?.exampleQueries ?? defaults.exampleQueries) as unknown as Prisma.InputJsonValue,
          excludedIntents: (routing?.excludedIntents ?? defaults.excludedIntents) as unknown as Prisma.InputJsonValue,
          routingKeywords: (routing?.routingKeywords ?? defaults.routingKeywords) as unknown as Prisma.InputJsonValue,
          enabledForChannelRouting: true,
          routingPriority: (routing?.routingPriority as number) ?? defaults.routingPriority,
          supportedTaskTypes: (routing?.supportedTaskTypes ?? defaults.supportedTaskTypes) as unknown as Prisma.InputJsonValue,
          requiredCapabilities: (routing?.requiredCapabilities ?? defaults.requiredCapabilities) as unknown as Prisma.InputJsonValue
        }
      });
      this.logger.log({ event: "RoutingProfileCreated", employeeInstallationId: plugin.id, organizationId: plugin.organizationId, source, profileSource: routing ? "MANIFEST" : "DEFAULTS" });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "P2002") return;
      this.logger.error({ event: "RoutingProfileCreationFailed", employeeInstallationId: plugin.id, organizationId: plugin.organizationId, source, error: String(error) });
      throw error;
    }
  }

  /**
   * Ordered category table for `defaultRoutingProfile()`. Each category owns a `slugPattern` (matched
   * against the plugin's precise, curated slug, e.g. "finance-employee") and a looser `descPattern`
   * (matched against free-text manifest description prose). Order matters only as a same-pass tie-break —
   * see the two-pass matching in `defaultRoutingProfile` below for why that keeps categories from
   * stealing each other's plugins via incidental keyword overlap in prose.
   */
  private static readonly ROUTING_CATEGORIES: ReadonlyArray<{
    employeeType: string;
    slugPattern: RegExp;
    descPattern: RegExp;
    summary: string;
    supportedDomains: string[];
    supportedIntents: string[];
    exampleQueries: string[];
    excludedIntents: string[];
    routingKeywords: string[];
  }> = [
    {
      employeeType: "TRAVEL",
      slugPattern: /travel|trip|holiday|booking|flight|hotel|vacation|tour/i,
      descPattern: /travel|trip|booking|holiday|vacation/i,
      summary: "Helps customers with: trip planning, hotels, visas, itinerary, travel budget.",
      supportedDomains: ["Travel"],
      supportedIntents: ["Trip Planning", "Hotel Booking", "Visa", "Budget", "Itinerary"],
      exampleQueries: ["Plan my Dubai trip", "Suggest hotels", "Estimate travel budget"],
      excludedIntents: ["HR", "Payroll", "IT Support", "Finance", "Legal"],
      routingKeywords: ["travel", "hotel", "visa", "flight", "holiday", "trip", "booking", "vacation", "tour"]
    },
    {
      employeeType: "IT_SUPPORT",
      // Deliberately does NOT match bare "it" or bare "support" — those are common English substrings
      // ("w-IT-h", "sen-sit-ive", "cus-tomer-SUPPORT-employee", "Support-s") that previously misclassified
      // Marketing/HR/Finance/Customer Support as IT_SUPPORT.
      slugPattern: /\bit[\s-]?support\b|\btech(?:nical)?[\s-]?support\b|\bhelpdesk\b|\bvpn\b|\bnetwork\b|\bcomputer\b|\bsoftware\b|\bhardware\b/i,
      descPattern: /\bit[\s-]?support\b|\btech(?:nical)?[\s-]?support\b|\bhelpdesk\b|\bvpn\b|\bnetwork\b/i,
      summary: "Helps customers with: IT support, VPN, network, software, hardware, password reset.",
      supportedDomains: ["IT"],
      supportedIntents: ["VPN Troubleshooting", "Password Reset", "Software Installation", "Network Issue", "Hardware Support"],
      exampleQueries: ["My VPN is not working", "I forgot my password", "My laptop is slow"],
      excludedIntents: ["HR", "Payroll", "Travel", "Finance", "Legal"],
      routingKeywords: ["vpn", "computer", "laptop", "password", "network", "software", "it support", "tech support", "helpdesk"]
    },
    {
      employeeType: "HR_POLICY",
      slugPattern: /hr|human.?resource|policy|leave|payroll|benefit|hiring|recruit/i,
      descPattern: /human.?resource|\bleave\b|\bpayroll\b|\bbenefit/i,
      summary: "Helps customers with: HR policies, leave, payroll, benefits, hiring.",
      supportedDomains: ["HR"],
      supportedIntents: ["Leave Policy", "Payroll Inquiry", "Benefits", "Hiring Process", "Employee Relations"],
      exampleQueries: ["What is the maternity leave policy?", "How do I apply for leave?", "What are my benefits?"],
      excludedIntents: ["Travel", "IT Support", "Finance", "Legal", "Sales"],
      routingKeywords: ["hr", "human resource", "leave", "maternity", "paternity", "policy", "payroll", "benefit", "hiring"]
    },
    {
      employeeType: "SALES",
      slugPattern: /sales|crm|sell|purchase|product|pricing|quote|order/i,
      descPattern: /\bsales\b|\bcrm\b|\bsell\b|\bpurchase\b|\bpricing\b|\bquote\b|\border\b/i,
      summary: "Helps customers with: product information, pricing, quotes, orders, invoices.",
      supportedDomains: ["Sales"],
      supportedIntents: ["Product Inquiry", "Pricing", "Quote Request", "Order Status", "Invoice"],
      exampleQueries: ["What products do you offer?", "I need a quote", "Where is my order?"],
      excludedIntents: ["HR", "IT Support", "Travel", "Finance", "Legal"],
      routingKeywords: ["sales", "product", "pricing", "quote", "order", "invoice", "purchase"]
    },
    {
      employeeType: "FINANCE",
      slugPattern: /finance|expense|invoice|budget|reimburse|accounting/i,
      descPattern: /\bfinance\b|\bexpense\b|\binvoice\b|\bbudget\b|\breimburse/i,
      summary: "Helps customers with: reports, invoices, expense classification, budgets, reimbursements.",
      supportedDomains: ["Finance"],
      supportedIntents: ["Expense Classification", "Invoice Support", "Budget Summary", "Report", "Approval Threshold"],
      exampleQueries: ["Classify this expense", "What is our budget?", "Check an invoice status"],
      excludedIntents: ["HR", "IT Support", "Travel", "Sales", "Legal"],
      routingKeywords: ["finance", "expense", "invoice", "budget", "report", "reimburse", "spend", "tax"]
    },
    {
      employeeType: "MARKETING",
      slugPattern: /marketing|campaign|content|brand|social|advert/i,
      descPattern: /\bmarketing\b|\bcampaign\b|\bbrand\b|\bsocial\b/i,
      summary: "Helps customers with: campaign planning, content, brand, social, performance.",
      supportedDomains: ["Marketing"],
      supportedIntents: ["Campaign Planning", "Content", "Social", "Performance Summary"],
      exampleQueries: ["Plan an email campaign", "Draft social content", "Summarise performance"],
      excludedIntents: ["HR", "IT Support", "Travel", "Finance", "Sales", "Legal"],
      routingKeywords: ["marketing", "campaign", "content", "brand", "social", "email marketing", "webinar"]
    },
    {
      employeeType: "LEGAL",
      slugPattern: /legal|notice|compliance|regulatory|gst|income.?tax|advocat|\bca\b/i,
      descPattern: /\blegal\b|\bnotice\b|\bcompliance\b|\bregulatory\b|\bgst\b/i,
      summary: "Helps customers with: legal and regulatory notices, reply drafting, deadlines.",
      supportedDomains: ["Legal"],
      supportedIntents: ["Notice Summarisation", "Reply Drafting", "Deadline Tracking"],
      exampleQueries: ["Summarise this GST notice", "Draft a reply to a show-cause notice", "When is the deadline?"],
      excludedIntents: ["HR", "IT Support", "Travel", "Finance", "Sales", "Marketing"],
      routingKeywords: ["legal", "notice", "gst", "income tax", "scrutiny", "compliance", "regulatory", "advocate", "ca"]
    },
    {
      employeeType: "CUSTOMER_SUPPORT",
      slugPattern: /customer.?support|helpdesk|ticket/i,
      descPattern: /customer.?support|helpdesk|\bticket/i,
      summary: "Helps customers with: order status, refunds, returns, billing, accounts, troubleshooting.",
      supportedDomains: ["Customer Support"],
      supportedIntents: ["Order Status", "Refund", "Return", "Billing", "Account", "Troubleshooting"],
      exampleQueries: ["Where is my order?", "Request a refund", "Reset my password"],
      excludedIntents: ["HR", "IT Support", "Travel", "Finance", "Sales", "Legal", "Marketing"],
      routingKeywords: ["customer support", "support", "help", "refund", "order status", "billing", "ticket", "complaint"]
    }
  ];

  private defaultRoutingProfile(plugin: { slug: string; displayName: string; description: string }): {
    displayName: string; employeeType: string | null; summary: string;
    supportedDomains: string[]; supportedIntents: string[]; exampleQueries: string[];
    excludedIntents: string[]; routingKeywords: string[]; routingPriority: number;
    supportedTaskTypes: string[]; requiredCapabilities: string[];
  } {
    const slug = plugin.slug.toLowerCase();
    const desc = (plugin.description ?? "").toLowerCase();
    const displayName = plugin.displayName;

    // Every employee that can reason at all needs LLM — this is the one capability requirement that's
    // genuinely universal rather than category-specific, so it's applied uniformly below rather than
    // hardcoded per category.
    const requiredCapabilities = ["LLM"];

    // Two-pass matching: the slug is a precise, curated identifier ("finance-employee") while the
    // description is free-text marketing prose that legitimately contains other categories' keywords in
    // passing (a Finance employee's description mentions "invoices", which is also a Sales keyword). Every
    // category's slug is checked before ANY category's description, so the authoritative signal always
    // wins over an incidental one — this is what actually fixes cross-category misclassification, not just
    // moving which single collision happens to occur first.
    for (const category of PluginService.ROUTING_CATEGORIES) {
      if (category.slugPattern.test(slug)) {
        const profile = pickCategoryProfile(category);
        return {
          displayName, routingPriority: 100, ...profile,
          supportedTaskTypes: taskTypesFromIntents(profile.supportedIntents), requiredCapabilities
        };
      }
    }
    for (const category of PluginService.ROUTING_CATEGORIES) {
      if (category.descPattern.test(desc)) {
        const profile = pickCategoryProfile(category);
        return {
          displayName, routingPriority: 100, ...profile,
          supportedTaskTypes: taskTypesFromIntents(profile.supportedIntents), requiredCapabilities
        };
      }
    }
    // Conservative default
    return {
      displayName, employeeType: null,
      summary: `Helps customers with requests related to ${displayName}.`,
      supportedDomains: [], supportedIntents: [], exampleQueries: [],
      excludedIntents: [],
      supportedTaskTypes: ["GENERAL_QUERY"], requiredCapabilities,
      routingKeywords: plugin.slug ? [plugin.slug.toLowerCase()] : [],
      routingPriority: 100
    };
  }

  async backfillRoutingProfiles(): Promise<number> {
    const plugins = await this.prisma.plugin.findMany({ where: { deletedAt: null } });
    let count = 0;
    for (const plugin of plugins) {
      const existing = await this.prisma.employeeRoutingProfile.findUnique({ where: { pluginInstallationId: plugin.id } });
      if (!existing) {
        await this.ensureRoutingProfile(plugin, "BACKFILL");
        count++;
      }
    }
    return count;
  }

  /**
   * Recomputes and repairs routing profiles that were derived from `defaultRoutingProfile()` (i.e. the
   * plugin's manifest never declared its own `routing` block) and no longer match what fresh computation
   * would produce — e.g. after fixing a classification bug. Profiles sourced from an explicit manifest
   * `routing` block are left untouched, since those represent deliberate configuration, not a guess.
   * Returns the number of profiles actually changed.
   */
  async repairRoutingProfiles(organizationId?: string): Promise<number> {
    const plugins = await this.prisma.plugin.findMany({
      where: { deletedAt: null, ...(organizationId ? { organizationId } : {}) }
    });
    let repaired = 0;
    for (const plugin of plugins) {
      const manifest = (plugin.manifest as Record<string, unknown>) ?? {};
      if (manifest.routing) continue; // explicit manifest configuration — never auto-repaired
      const existing = await this.prisma.employeeRoutingProfile.findUnique({
        where: { pluginInstallationId: plugin.id }
      });
      if (!existing) continue;
      const fresh = this.defaultRoutingProfile(plugin);
      const changed =
        existing.employeeType !== fresh.employeeType ||
        JSON.stringify(existing.supportedDomains) !== JSON.stringify(fresh.supportedDomains) ||
        JSON.stringify(existing.supportedIntents) !== JSON.stringify(fresh.supportedIntents) ||
        JSON.stringify(existing.routingKeywords) !== JSON.stringify(fresh.routingKeywords) ||
        JSON.stringify(existing.excludedIntents) !== JSON.stringify(fresh.excludedIntents) ||
        JSON.stringify(existing.supportedTaskTypes) !== JSON.stringify(fresh.supportedTaskTypes) ||
        JSON.stringify(existing.requiredCapabilities) !== JSON.stringify(fresh.requiredCapabilities) ||
        existing.summary !== fresh.summary;
      if (!changed) continue;
      await this.prisma.employeeRoutingProfile.update({
        where: { pluginInstallationId: plugin.id },
        data: {
          employeeType: fresh.employeeType,
          summary: fresh.summary,
          supportedDomains: fresh.supportedDomains as unknown as Prisma.InputJsonValue,
          supportedIntents: fresh.supportedIntents as unknown as Prisma.InputJsonValue,
          exampleQueries: fresh.exampleQueries as unknown as Prisma.InputJsonValue,
          excludedIntents: fresh.excludedIntents as unknown as Prisma.InputJsonValue,
          routingKeywords: fresh.routingKeywords as unknown as Prisma.InputJsonValue,
          supportedTaskTypes: fresh.supportedTaskTypes as unknown as Prisma.InputJsonValue,
          requiredCapabilities: fresh.requiredCapabilities as unknown as Prisma.InputJsonValue
        }
      });
      this.logger.log({
        event: "RoutingProfileRepaired",
        employeeInstallationId: plugin.id,
        organizationId: plugin.organizationId,
        from: existing.employeeType,
        to: fresh.employeeType
      });
      repaired++;
    }
    return repaired;
  }

  // Wire startup consistency check
  // Note: onModuleInit already calls synchronizeRegistry. The check below is separate.
}

interface RoutingCategoryProfile {
  employeeType: string; summary: string; supportedDomains: string[]; supportedIntents: string[];
  exampleQueries: string[]; excludedIntents: string[]; routingKeywords: string[];
}

/** Strips the regex-matching fields off a ROUTING_CATEGORIES entry, leaving only the storable profile
 *  data — explicit field selection instead of destructure-and-discard so unused-var lint stays clean. */
function pickCategoryProfile(category: RoutingCategoryProfile & { slugPattern: RegExp; descPattern: RegExp }): RoutingCategoryProfile {
  return {
    employeeType: category.employeeType,
    summary: category.summary,
    supportedDomains: category.supportedDomains,
    supportedIntents: category.supportedIntents,
    exampleQueries: category.exampleQueries,
    excludedIntents: category.excludedIntents,
    routingKeywords: category.routingKeywords
  };
}

/** "Leave Policy" -> "LEAVE_POLICY". Derives collaboration task-type identifiers from an employee's own
 *  declared intents rather than inventing a separate, hardcoded task-type taxonomy per category. */
function taskTypesFromIntents(intents: readonly string[]): string[] {
  const derived = intents.map((intent) =>
    intent
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  );
  return [...new Set([...derived, "GENERAL_QUERY"])];
}
