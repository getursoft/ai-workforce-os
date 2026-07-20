import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit
} from "@nestjs/common";
import {
  ConnectorActorType,
  ConnectorExecutionStatus,
  ConnectorHealthStatus,
  ConnectorInstallationStatus,
  Prisma
} from "@prisma/client";
import type {
  Connector,
  ConnectorManifest,
  ConnectorToolManifest
} from "@ai-workforce-os/connector-sdk";
import type { ToolHandler } from "../agents/agent.runtime";
import { AuditEventLogger } from "../identity/presentation/http/audit-event.logger";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { SafeHttpTool } from "../plugins/plugin-ai.runtime";
import {
  bounded,
  ConnectorManifestValidator,
  ConnectorRegistry,
  ConnectorSchemaValidator,
  ConnectorValidationError,
  connectorContext
} from "./connector.runtime";
import { DummyCrmConnector, GenericHttpConnector } from "./reference-connectors";
import type {
  ConnectorEventDto,
  ConnectorEventQueryDto,
  ConnectorInstallationQueryDto,
  ConnectorPageDto,
  InstallConnectorDto,
  UpdateConnectorCapabilitiesDto,
  UpdateConnectorConfigurationDto,
  UpdateConnectorCredentialsDto,
  UpdateConnectorDto
} from "./connector.dto";

@Injectable()
export class ConnectorService implements OnModuleInit {
  private readonly logger = new Logger(ConnectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: PluginSecretsEncryptionService,
    private readonly http: SafeHttpTool,
    private readonly manifests: ConnectorManifestValidator,
    private readonly schemas: ConnectorSchemaValidator,
    private readonly registry: ConnectorRegistry,
    private readonly auditLogger: AuditEventLogger
  ) {
    this.registry.register(new DummyCrmConnector(this.prisma));
    this.registry.register(new GenericHttpConnector(this.http));
  }

  async onModuleInit() {
    try {
      for (const connector of this.registry.list()) await this.upsertDefinition(connector.manifest);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") {
        this.logger.error(
          "Connector database schema is missing. Run `pnpm db:migrate` against the API DATABASE_URL before starting the API."
        );
        throw new Error("CONNECTOR_SCHEMA_MISSING");
      }
      throw error;
    }
  }

  async catalogue(organizationId: string) {
    const installed = new Set(
      (
        await this.prisma.connectorInstallation.findMany({
          where: { organizationId, deletedAt: null },
          select: { connectorId: true }
        })
      ).map((item) => item.connectorId)
    );
    const definitions = await this.prisma.connectorDefinition.findMany({
      where: { status: "ACTIVE" },
      include: { tools: true },
      orderBy: { name: "asc" }
    });
    return definitions.map((definition) => ({
      ...this.definition(definition),
      installed: installed.has(definition.id)
    }));
  }

  async definitionById(organizationId: string, id: string) {
    void organizationId;
    const definition = await this.prisma.connectorDefinition.findFirst({
      where: { OR: [{ id }, { key: id }], status: "ACTIVE" },
      include: { tools: true }
    });
    if (!definition) throw new NotFoundException("CONNECTOR_NOT_FOUND");
    return this.definition(definition);
  }

  async install(
    organizationId: string,
    userId: string,
    requestId: string,
    dto: InstallConnectorDto
  ) {
    const definition = await this.prisma.connectorDefinition.findUnique({
      where: { key: dto.connectorKey },
      include: { tools: true }
    });
    if (!definition) throw new NotFoundException("CONNECTOR_NOT_FOUND");
    const connector = this.requireConnector(definition.key);
    const configuration = dto.configuration ?? {};
    const credentials = dto.credentials ?? {};
    this.validateConfiguration(connector.manifest, configuration);
    this.validateCredentials(connector.manifest, credentials);
    const declared = new Set(connector.manifest.capabilities);
    const grants = [...new Set(dto.grantedCapabilities ?? [])];
    if (grants.some((grant) => !declared.has(grant)))
      throw new BadRequestException("CONNECTOR_CAPABILITY_NOT_GRANTED");
    try {
      const installation = await this.prisma.connectorInstallation.create({
        data: {
          organizationId,
          connectorId: definition.id,
          displayName: dto.displayName.trim(),
          configuration: configuration as Prisma.InputJsonValue,
          encryptedCredentials: this.secrets.encrypt(
            credentials
          ) as unknown as Prisma.InputJsonValue,
          credentialMetadata: credentialMetadata(credentials) as Prisma.InputJsonValue,
          grantedCapabilities: grants as Prisma.InputJsonValue,
          credentialExpiresAt: date(dto.credentialExpiresAt),
          createdByUserId: userId
        },
        include: { connector: { include: { tools: true } } }
      });
      await connector.initialize?.(await this.context(installation, userId, requestId));
      await this.audit(organizationId, installation.id, userId, requestId, "CONNECTOR_INSTALLED");
      return this.sanitize(installation);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new ConflictException("CONNECTOR_ALREADY_INSTALLED");
      throw error;
    }
  }

  async list(organizationId: string, query: ConnectorInstallationQueryDto) {
    const where: Prisma.ConnectorInstallationWhereInput = {
      organizationId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { displayName: { contains: query.search, mode: "insensitive" } },
              { connector: { name: { contains: query.search, mode: "insensitive" } } }
            ]
          }
        : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.connectorInstallation.findMany({
        where,
        include: { connector: { include: { tools: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.connectorInstallation.count({ where })
    ]);
    return page(
      items.map((item) => this.sanitize(item)),
      total,
      query
    );
  }

  async get(organizationId: string, id: string) {
    return this.sanitize(await this.requireInstallation(organizationId, id));
  }

  async update(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    dto: UpdateConnectorDto
  ) {
    await this.requireInstallation(organizationId, id);
    const updated = await this.prisma.connectorInstallation.update({
      where: { id },
      data: { ...(dto.displayName ? { displayName: dto.displayName.trim() } : {}) },
      include: { connector: { include: { tools: true } } }
    });
    await this.audit(organizationId, id, userId, requestId, "CONNECTOR_CONFIGURATION_UPDATED");
    return this.sanitize(updated);
  }

  async updateConfiguration(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    dto: UpdateConnectorConfigurationDto
  ) {
    const installation = await this.requireInstallation(organizationId, id);
    const connector = this.requireConnector(installation.connector.key);
    this.validateConfiguration(connector.manifest, dto.configuration);
    await connector.validateConfiguration?.(dto.configuration);
    const updated = await this.prisma.connectorInstallation.update({
      where: { id },
      data: { configuration: dto.configuration as Prisma.InputJsonValue },
      include: { connector: { include: { tools: true } } }
    });
    await this.audit(organizationId, id, userId, requestId, "CONNECTOR_CONFIGURATION_UPDATED");
    return this.sanitize(updated);
  }

  async updateCredentials(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    dto: UpdateConnectorCredentialsDto
  ) {
    const installation = await this.requireInstallation(organizationId, id);
    const connector = this.requireConnector(installation.connector.key);
    this.validateCredentials(connector.manifest, dto.credentials);
    await connector.validateCredentials?.(dto.credentials);
    const updated = await this.prisma.connectorInstallation.update({
      where: { id },
      data: {
        encryptedCredentials: this.secrets.encrypt(
          dto.credentials
        ) as unknown as Prisma.InputJsonValue,
        credentialMetadata: credentialMetadata(dto.credentials) as Prisma.InputJsonValue,
        credentialExpiresAt: date(dto.credentialExpiresAt),
        status: ConnectorInstallationStatus.DRAFT
      },
      include: { connector: { include: { tools: true } } }
    });
    await this.audit(organizationId, id, userId, requestId, "CONNECTOR_CREDENTIALS_UPDATED");
    return this.sanitize(updated);
  }

  async removeCredentials(organizationId: string, userId: string, requestId: string, id: string) {
    await this.requireInstallation(organizationId, id);
    const updated = await this.prisma.connectorInstallation.update({
      where: { id },
      data: {
        encryptedCredentials: this.secrets.encrypt({}) as unknown as Prisma.InputJsonValue,
        credentialMetadata: {},
        credentialExpiresAt: null,
        status: ConnectorInstallationStatus.DISCONNECTED
      },
      include: { connector: { include: { tools: true } } }
    });
    await this.audit(organizationId, id, userId, requestId, "CONNECTOR_CREDENTIALS_REMOVED");
    return this.sanitize(updated);
  }

  capabilities(organizationId: string, id: string) {
    return this.get(organizationId, id).then((item) => ({
      declared: item.connector.capabilities,
      granted: item.grantedCapabilities
    }));
  }

  async updateCapabilities(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    dto: UpdateConnectorCapabilitiesDto
  ) {
    const installation = await this.requireInstallation(organizationId, id);
    const declared = new Set(jsonStrings(installation.connector.declaredCapabilities));
    if (dto.grantedCapabilities.some((item) => !declared.has(item)))
      throw new BadRequestException("CONNECTOR_CAPABILITY_NOT_GRANTED");
    const updated = await this.prisma.connectorInstallation.update({
      where: { id },
      data: { grantedCapabilities: [...new Set(dto.grantedCapabilities)] as Prisma.InputJsonValue },
      include: { connector: { include: { tools: true } } }
    });
    await this.audit(organizationId, id, userId, requestId, "CONNECTOR_CAPABILITIES_UPDATED");
    return this.sanitize(updated);
  }

  async lifecycle(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    action: "enable" | "disable" | "test" | "health" | "disconnect" | "reconnect"
  ) {
    const installation = await this.requireInstallation(organizationId, id);
    const connector = this.requireConnector(installation.connector.key);
    if (action === "disable" || action === "disconnect") {
      if (action === "disconnect")
        await connector.disconnect?.(await this.context(installation, userId, requestId));
      const status =
        action === "disable"
          ? ConnectorInstallationStatus.DISABLED
          : ConnectorInstallationStatus.DISCONNECTED;
      const updated = await this.prisma.connectorInstallation.update({
        where: { id },
        data: { status, lastHealthStatus: ConnectorHealthStatus.DISCONNECTED },
        include: { connector: { include: { tools: true } } }
      });
      await this.audit(organizationId, id, userId, requestId, `CONNECTOR_${action.toUpperCase()}D`);
      return this.sanitize(updated);
    }
    const credentials = this.decrypt(installation.encryptedCredentials);
    if (connector.manifest.authType !== "NONE" && Object.keys(credentials).length === 0)
      throw new BadRequestException("CONNECTOR_CREDENTIALS_REQUIRED");
    const operation =
      action === "health"
        ? connector.healthCheck(await this.context(installation, userId, requestId))
        : connector.testConnection(await this.context(installation, userId, requestId));
    const health = await bounded(operation, 30000);
    const status =
      action === "enable" || action === "reconnect"
        ? ConnectorInstallationStatus.READY
        : installation.status;
    const updated = await this.prisma.connectorInstallation.update({
      where: { id },
      data: {
        status,
        lastHealthStatus: health.status,
        lastHealthCheckedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null
      },
      include: { connector: { include: { tools: true } } }
    });
    await this.audit(
      organizationId,
      id,
      userId,
      requestId,
      action === "health" ? "CONNECTOR_HEALTH_CHECKED" : `CONNECTOR_${action.toUpperCase()}D`
    );
    return this.sanitize(updated);
  }

  async remove(organizationId: string, userId: string, requestId: string, id: string) {
    await this.requireInstallation(organizationId, id);
    await this.prisma.connectorInstallation.update({
      where: { id },
      data: { status: "ARCHIVED", deletedAt: new Date() }
    });
    await this.audit(organizationId, id, userId, requestId, "CONNECTOR_ARCHIVED");
  }

  async tools(organizationId: string, id: string) {
    const installation = await this.requireInstallation(organizationId, id);
    return installation.connector.tools;
  }

  async executions(organizationId: string, id: string, query: ConnectorPageDto) {
    await this.requireInstallation(organizationId, id);
    const where = { organizationId, connectorInstallationId: id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.connectorExecution.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.connectorExecution.count({ where })
    ]);
    return page(items, total, query);
  }
  async events(organizationId: string, id: string, query: ConnectorEventQueryDto) {
    await this.requireInstallation(organizationId, id);
    const where = {
      organizationId,
      connectorInstallationId: id,
      ...(query.status ? { status: query.status } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.connectorEvent.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.connectorEvent.count({ where })
    ]);
    return page(items, total, query);
  }
  async audits(organizationId: string, id: string, query: ConnectorPageDto) {
    await this.requireInstallation(organizationId, id);
    const where = { organizationId, connectorInstallationId: id };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.connectorAuditEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.prisma.connectorAuditEvent.count({ where })
    ]);
    return page(items, total, query);
  }

  async ingest(
    organizationId: string,
    userId: string,
    requestId: string,
    id: string,
    dto: ConnectorEventDto
  ) {
    const installation = await this.requireInstallation(organizationId, id);
    if (JSON.stringify(dto.payload).length > 256000)
      throw new BadRequestException("CONNECTOR_EVENT_TOO_LARGE");
    const connector = this.requireConnector(installation.connector.key);
    const declared = connector.manifest.events?.find((event) => event.type === dto.eventType);
    if (!declared && connector.manifest.events?.length)
      throw new BadRequestException("CONNECTOR_EVENT_INVALID");
    if (declared)
      this.schemas.validate(
        `event:${connector.manifest.id}:${dto.eventType}`,
        declared.payloadSchema,
        dto.payload
      );
    try {
      const event = await this.prisma.connectorEvent.create({
        data: {
          organizationId,
          connectorInstallationId: id,
          eventType: dto.eventType,
          externalEventId: dto.externalEventId,
          payload: dto.payload as Prisma.InputJsonValue
        }
      });
      await this.audit(organizationId, id, userId, requestId, "CONNECTOR_EVENT_RECEIVED");
      return event;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        return this.prisma.connectorEvent.findUniqueOrThrow({
          where: {
            connectorInstallationId_externalEventId: {
              connectorInstallationId: id,
              externalEventId: dto.externalEventId
            }
          }
        });
      throw error;
    }
  }

  toolHandlers(): ToolHandler[] {
    return this.registry
      .list()
      .flatMap((connector) =>
        connector.manifest.tools.map((tool) => this.toolHandler(connector, tool))
      );
  }

  async availableToolNames(
    organizationId: string,
    pluginCapabilities: ReadonlySet<string>
  ): Promise<string[]> {
    const installations = await this.prisma.connectorInstallation.findMany({
      where: {
        organizationId,
        status: ConnectorInstallationStatus.READY,
        deletedAt: null
      },
      include: { connector: { include: { tools: { where: { enabled: true } } } } }
    });
    return installations.flatMap((installation) => {
      const grants = new Set(jsonStrings(installation.grantedCapabilities));
      return installation.connector.tools
        .filter(
          (tool) =>
            grants.has(tool.requiredCapability) && pluginCapabilities.has(tool.requiredCapability)
        )
        .map((tool) => `connector.${installation.connector.key}.${tool.name}`);
    });
  }

  private toolHandler(connector: Connector, tool: ConnectorToolManifest): ToolHandler {
    const name = `connector.${connector.manifest.id}.${tool.name}`;
    return {
      definition: {
        name,
        version: connector.manifest.version,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        requiredPermissions: ["agents.tools.execute"],
        timeoutMs: tool.timeoutMs,
        sensitiveInputPaths: [],
        sensitiveOutputPaths: []
      },
      execute: async (input, context) => {
        const installation = await this.prisma.connectorInstallation.findFirst({
          where: {
            organizationId: context.organizationId,
            connector: { key: connector.manifest.id },
            status: ConnectorInstallationStatus.READY,
            deletedAt: null
          },
          include: { connector: { include: { tools: true } } }
        });
        if (!installation) throw new Error("CONNECTOR_DISABLED");
        const grants = jsonStrings(installation.grantedCapabilities);
        if (!grants.includes(tool.requiredCapability))
          throw new Error("CONNECTOR_CAPABILITY_NOT_GRANTED");
        return this.execute(
          connector,
          installation,
          tool,
          input,
          ConnectorActorType.AGENT,
          context.userId,
          context.conversationId
        );
      }
    };
  }

  private async execute(
    connector: Connector,
    installation: Awaited<ReturnType<ConnectorService["requireInstallation"]>>,
    tool: ConnectorToolManifest,
    input: Record<string, unknown>,
    actorType: ConnectorActorType,
    actorId: string,
    requestId: string
  ) {
    this.schemas.validate(`tool:${connector.manifest.id}:${tool.name}`, tool.inputSchema, input);
    const started = Date.now();
    const execution = await this.prisma.connectorExecution.create({
      data: {
        organizationId: installation.organizationId,
        connectorInstallationId: installation.id,
        toolName: tool.name,
        actorType,
        actorId,
        requestMetadata: { requestId },
        input: sanitize(input) as Prisma.InputJsonValue
      }
    });
    try {
      const output = await bounded(
        connector.executeTool(
          tool.name,
          input,
          await this.context(installation, actorId, requestId)
        ),
        tool.timeoutMs
      );
      const safeOutput = sanitize(output);
      if (JSON.stringify(safeOutput).length > 256_000)
        throw new Error("CONNECTOR_RESPONSE_INVALID");
      await this.prisma.connectorExecution.update({
        where: { id: execution.id },
        data: {
          status: ConnectorExecutionStatus.SUCCEEDED,
          output: safeOutput as Prisma.InputJsonValue,
          latencyMs: Date.now() - started
        }
      });
      return safeOutput;
    } catch (error) {
      const code = safeCode(error);
      await this.prisma.connectorExecution.update({
        where: { id: execution.id },
        data: {
          status: code === "CONNECTOR_TOOL_TIMEOUT" ? "TIMED_OUT" : "FAILED",
          latencyMs: Date.now() - started,
          errorCode: code,
          errorMessage: "Connector tool execution failed"
        }
      });
      throw error;
    }
  }

  private async context(
    installation: Awaited<ReturnType<ConnectorService["requireInstallation"]>>,
    actorId: string,
    requestId: string
  ) {
    return connectorContext({
      organizationId: installation.organizationId,
      installationId: installation.id,
      actorId,
      requestId,
      configuration: installation.configuration as Record<string, unknown>,
      credentials: this.decrypt(installation.encryptedCredentials),
      grantedCapabilities: jsonStrings(installation.grantedCapabilities)
    });
  }

  private async requireInstallation(organizationId: string, id: string) {
    const installation = await this.prisma.connectorInstallation.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { connector: { include: { tools: true } } }
    });
    if (!installation) throw new NotFoundException("CONNECTOR_INSTALLATION_NOT_FOUND");
    return installation;
  }
  private requireConnector(key: string) {
    const connector = this.registry.resolve(key);
    if (!connector) throw new NotFoundException("CONNECTOR_NOT_FOUND");
    return connector;
  }
  private validateConfiguration(manifest: ConnectorManifest, value: Record<string, unknown>) {
    this.validate(`configuration:${manifest.id}`, manifest.configurationSchema, value);
  }
  private validateCredentials(manifest: ConnectorManifest, value: Record<string, string>) {
    this.validate(`credentials:${manifest.id}`, manifest.credentialSchema, value);
  }
  private validate(key: string, schema: Readonly<Record<string, unknown>>, value: unknown) {
    try {
      this.schemas.validate(key, schema as Record<string, unknown>, value);
    } catch (error) {
      if (error instanceof ConnectorValidationError) throw new BadRequestException(error.details);
      throw error;
    }
  }
  private decrypt(value: unknown) {
    return this.secrets.decrypt(value as EncryptedPayload);
  }
  private sanitize<
    T extends { encryptedCredentials: unknown; connector: { declaredCapabilities: unknown } }
  >(installation: T) {
    const safe = { ...installation } as Omit<T, "encryptedCredentials"> &
      Partial<Pick<T, "encryptedCredentials">>;
    delete safe.encryptedCredentials;
    return {
      ...safe,
      grantedCapabilities: jsonStrings(
        (installation as { grantedCapabilities?: unknown }).grantedCapabilities
      ),
      credentialMetadata:
        (installation as { credentialMetadata?: unknown }).credentialMetadata ?? {},
      connector: {
        ...installation.connector,
        capabilities: jsonStrings(installation.connector.declaredCapabilities)
      }
    };
  }
  private definition<T extends { declaredCapabilities: unknown; manifest: unknown }>(
    definition: T
  ) {
    const safe = { ...definition } as Omit<T, "manifest"> & Partial<Pick<T, "manifest">>;
    delete safe.manifest;
    return { ...safe, capabilities: jsonStrings(definition.declaredCapabilities) };
  }
  private async upsertDefinition(manifestInput: ConnectorManifest) {
    const manifest = this.manifests.validate(manifestInput);
    await this.prisma.$transaction(async (tx) => {
      const definition = await tx.connectorDefinition.upsert({
        where: { key: manifest.id },
        create: {
          key: manifest.id,
          name: manifest.name,
          description: manifest.description,
          category: manifest.category,
          version: manifest.version,
          authType: manifest.authType,
          manifest: manifest as unknown as Prisma.InputJsonValue,
          declaredCapabilities: [...manifest.capabilities] as Prisma.InputJsonValue,
          configurationSchema: manifest.configurationSchema as Prisma.InputJsonValue,
          credentialSchema: manifest.credentialSchema as Prisma.InputJsonValue
        },
        update: {
          name: manifest.name,
          description: manifest.description,
          category: manifest.category,
          version: manifest.version,
          authType: manifest.authType,
          manifest: manifest as unknown as Prisma.InputJsonValue,
          declaredCapabilities: [...manifest.capabilities] as Prisma.InputJsonValue,
          configurationSchema: manifest.configurationSchema as Prisma.InputJsonValue,
          credentialSchema: manifest.credentialSchema as Prisma.InputJsonValue
        }
      });
      await tx.connectorTool.deleteMany({ where: { connectorId: definition.id } });
      await tx.connectorTool.createMany({
        data: manifest.tools.map((tool) => ({
          connectorId: definition.id,
          name: tool.name,
          displayName: tool.displayName,
          description: tool.description,
          inputSchema: tool.inputSchema as Prisma.InputJsonValue,
          outputSchema: tool.outputSchema
            ? (tool.outputSchema as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          requiredCapability: tool.requiredCapability,
          operationType: tool.operationType,
          riskLevel: tool.riskLevel,
          timeoutMs: tool.timeoutMs
        }))
      });
    });
  }
  private audit(
    organizationId: string,
    installationId: string | null,
    userId: string,
    requestId: string,
    event: string
  ) {
    this.auditLogger.record(event, requestId, {
      organizationId,
      userId,
      ...(installationId ? { targetId: installationId } : {})
    });
    return this.prisma.connectorAuditEvent.create({
      data: {
        organizationId,
        connectorInstallationId: installationId,
        userId,
        requestId,
        event,
        metadata: {}
      }
    });
  }
}

function jsonStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function credentialMetadata(credentials: Record<string, string>) {
  const now = new Date().toISOString();
  return Object.fromEntries(
    Object.keys(credentials).map((key) => [key, { configured: true, updatedAt: now }])
  );
}
function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed <= new Date())
    throw new BadRequestException("CONNECTOR_CREDENTIALS_INVALID");
  return parsed;
}
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|secret|password|authorization|api.?key/i.test(key) ? "[REDACTED]" : sanitize(item)
    ])
  );
}
function safeCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "CONNECTOR_TOOL_EXECUTION_FAILED";
}
function page<T>(items: T[], total: number, query: ConnectorPageDto) {
  return {
    items,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      pages: Math.ceil(total / query.pageSize)
    }
  };
}
