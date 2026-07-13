import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException
} from "@nestjs/common";
import { PluginStatus, Prisma } from "@prisma/client";
import { DummyEchoPlugin } from "@ai-workforce-os/plugin-dummy";
import type { PluginManifest } from "@ai-workforce-os/plugin-sdk";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import {
  ConfigurationSchemaValidator,
  ManifestValidator,
  type EncryptedPayload,
  PluginRegistry,
  PluginSecretsEncryptionService,
  PluginValidationError
} from "./plugin.runtime";
import type {
  InstallPluginDto,
  PluginQueryDto,
  UpdatePluginConfigurationDto,
  UpdatePluginDto
} from "./plugin.dto";

@Injectable()
export class PluginService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manifests: ManifestValidator,
    private readonly schemas: ConfigurationSchemaValidator,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly registry: PluginRegistry
  ) {}

  async onModuleInit(): Promise<void> {
    await this.synchronizeRegistry();
  }

  async install(organizationId: string, userId: string, dto: InstallPluginDto) {
    const manifest = this.validateManifest(dto.manifest);
    if (manifest.id !== manifest.entryPoint)
      throw new UnprocessableEntityException("Manifest id and entryPoint must match");
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
        return this.sanitize(plugin);
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
  async enable(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
    if (plugin.status === PluginStatus.DEPRECATED) throw new ConflictException("PLUGIN_DEPRECATED");
    if (!this.registry.has(organizationId, plugin.slug))
      this.registry.register(organizationId, plugin.slug, this.adapter(plugin.entryPoint));
    return this.sanitize(
      await this.prisma.plugin.update({ where: { id }, data: { status: PluginStatus.ACTIVE } })
    );
  }
  async disable(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
    this.registry.unregister(organizationId, plugin.slug);
    return this.sanitize(
      await this.prisma.plugin.update({ where: { id }, data: { status: PluginStatus.DISABLED } })
    );
  }
  async remove(organizationId: string, id: string) {
    const plugin = await this.require(organizationId, id);
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
      Object.entries(dto.secrets ?? {}).filter(([, value]) => value === null).map(([key]) => key)
    );
    const merged = Object.fromEntries(
      Object.entries(this.secrets.decrypt(row.encryptedSecrets as unknown as EncryptedPayload))
        .filter(([key]) => !removals.has(key))
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
      return { status: "DISABLED", checkedAt: new Date().toISOString() };
    return this.registry.health(organizationId, plugin.slug);
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
            this.adapter(plugin.entryPoint)
          );
      } catch {
        /* one invalid installation must not stop startup */
      }
    }
  }
  private adapter(entryPoint: string) {
    if (entryPoint === "dummy-echo") return new DummyEchoPlugin();
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
    return plugin;
  }
}
