import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";
import { SafeHttpTool } from "../plugins/plugin-ai.runtime";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import type { CreateAiProviderConnectionDto, UpdateAiProviderConnectionDto } from "./ai-configuration.dto";

const CONNECTION_TEST_CACHE_MS = 60_000;

/** Manages AiProviderConnection rows — the one place a shared provider credential is stored,
 *  encrypted once, and reused by many AiModelProfile rows. Never returns a decrypted credential;
 *  callers only ever learn whether one is "configured". */
@Injectable()
export class AiProviderConnectionService {
  private readonly healthCache = new Map<string, { at: number; result: ConnectionTestResult }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService,
    private readonly http: SafeHttpTool,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}

  async list(organizationId: string) {
    const rows = await this.prisma.aiProviderConnection.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { modelProfiles: true } } }
    });
    return rows.map((row) => this.toSafeConnection(row));
  }

  async get(organizationId: string, id: string) {
    const row = await this.requireConnection(organizationId, id);
    return this.toSafeConnection(row);
  }

  async create(organizationId: string, userId: string, dto: CreateAiProviderConnectionDto) {
    this.assertProviderAllowed(dto.providerType);
    if (dto.providerType !== "DETERMINISTIC" && !dto.apiKey?.trim())
      throw new BadRequestException("AI_PROVIDER_CREDENTIAL_REQUIRED");
    const encrypted = this.encryption.encrypt(dto.apiKey?.trim() ? { apiKey: dto.apiKey.trim() } : {});
    if (dto.isDefault)
      await this.prisma.aiProviderConnection.updateMany({
        where: { organizationId, isDefault: true },
        data: { isDefault: false }
      });
    const row = await this.prisma.aiProviderConnection.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        providerType: dto.providerType,
        baseUrl: dto.baseUrl?.trim() ?? null,
        encryptedCredentialJson: encrypted as unknown as Prisma.InputJsonValue,
        metadataJson: (dto.metadataJson ?? {}) as Prisma.InputJsonValue,
        isDefault: dto.isDefault ?? false,
        createdByUserId: userId
      },
      include: { _count: { select: { modelProfiles: true } } }
    });
    return this.toSafeConnection(row);
  }

  async update(organizationId: string, id: string, dto: UpdateAiProviderConnectionDto) {
    const existing = await this.requireConnection(organizationId, id);
    let encryptedCredentialJson = existing.encryptedCredentialJson as unknown as Prisma.InputJsonValue;
    if (dto.removeCredential) {
      encryptedCredentialJson = this.encryption.encrypt({}) as unknown as Prisma.InputJsonValue;
    } else if (dto.apiKey?.trim()) {
      encryptedCredentialJson = this.encryption.encrypt({
        apiKey: dto.apiKey.trim()
      }) as unknown as Prisma.InputJsonValue;
    }
    if (dto.isDefault)
      await this.prisma.aiProviderConnection.updateMany({
        where: { organizationId, isDefault: true, id: { not: id } },
        data: { isDefault: false }
      });
    const row = await this.prisma.aiProviderConnection.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.baseUrl !== undefined ? { baseUrl: dto.baseUrl.trim() } : {}),
        ...(dto.metadataJson !== undefined ? { metadataJson: dto.metadataJson as Prisma.InputJsonValue } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
        encryptedCredentialJson
      },
      include: { _count: { select: { modelProfiles: true } } }
    });
    this.healthCache.delete(id);
    return this.toSafeConnection(row);
  }

  /** Refuses deletion while any AiModelProfile still references this connection — matching the
   *  same "block destructive delete until dependents are migrated/removed" rule used elsewhere in
   *  this codebase (e.g. connector/knowledge-collection deletes with active dependents). */
  async delete(organizationId: string, id: string) {
    await this.requireConnection(organizationId, id);
    const dependentProfiles = await this.prisma.aiModelProfile.count({
      where: { organizationId, providerConnectionId: id }
    });
    if (dependentProfiles > 0)
      throw new ConflictException("AI_PROVIDER_CONNECTION_HAS_MODEL_PROFILES");
    await this.prisma.aiProviderConnection.delete({ where: { id } });
    this.healthCache.delete(id);
  }

  /** Connection-level test: verifies the base URL is reachable and the credential is valid —
   *  deliberately model-agnostic (lists models / deployments rather than running a completion),
   *  since a connection has no single model of its own. Cached briefly so a dashboard refresh
   *  doesn't re-hit the provider on every page load. */
  async testConnection(organizationId: string, id: string): Promise<ConnectionTestResult> {
    const cached = this.healthCache.get(id);
    if (cached && Date.now() - cached.at < CONNECTION_TEST_CACHE_MS) return cached.result;
    const connection = await this.requireConnection(organizationId, id);
    const result = await this.runConnectionTest(connection);
    this.healthCache.set(id, { at: Date.now(), result });
    await this.prisma.aiProviderConnection.update({
      where: { id },
      data: {
        lastHealthCheckAt: new Date(),
        lastHealthStatus: result.status === "HEALTHY" ? "HEALTHY" : result.status === "UNKNOWN" ? "UNKNOWN" : "UNHEALTHY"
      }
    });
    return result;
  }

  /** Best-effort model list for "Refresh Models" in the UI. Not authoritative for every provider —
   *  callers must still allow manual model entry when this returns an empty list (e.g. Azure
   *  OpenAI's deployment-list shape varies by API version, and some OpenAI-compatible providers
   *  don't expose /models at all). */
  async discoverModels(organizationId: string, id: string): Promise<string[]> {
    const connection = await this.requireConnection(organizationId, id);
    if (connection.providerType === "DETERMINISTIC") return [];
    const secrets = this.decrypt(connection.encryptedCredentialJson);
    if (!secrets.apiKey) return [];
    try {
      if (connection.providerType === "OPENAI_COMPATIBLE") {
        const base = (connection.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const response = await this.http.execute(
          { method: "GET", url: `${base}/models`, timeoutMs: 8000 },
          { Authorization: `Bearer ${secrets.apiKey}` }
        );
        if (response.status !== 200) return [];
        const body = response.body as { data?: Array<{ id?: string }> } | null;
        return (body?.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)).sort();
      }
      if (connection.providerType === "AZURE_OPENAI" && connection.baseUrl) {
        const metadata = (connection.metadataJson ?? {}) as { apiVersion?: string };
        const apiVersion = metadata.apiVersion ?? "2024-02-01";
        const response = await this.http.execute(
          {
            method: "GET",
            url: `${connection.baseUrl.replace(/\/$/, "")}/openai/deployments?api-version=${apiVersion}`,
            timeoutMs: 8000
          },
          { "api-key": secrets.apiKey }
        );
        if (response.status !== 200) return [];
        const body = response.body as { data?: Array<{ id?: string }> } | null;
        return (body?.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)).sort();
      }
    } catch {
      return [];
    }
    return [];
  }

  private async runConnectionTest(connection: {
    providerType: "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
    baseUrl: string | null;
    encryptedCredentialJson: unknown;
    metadataJson: unknown;
  }): Promise<ConnectionTestResult> {
    const started = Date.now();
    if (connection.providerType === "DETERMINISTIC")
      return {
        status: "HEALTHY",
        providerReachable: true,
        authenticationValid: true,
        modelAvailable: null,
        latencyMs: 0,
        errorCode: null
      };
    const secrets = this.decrypt(connection.encryptedCredentialJson);
    if (!secrets.apiKey)
      return {
        status: "UNHEALTHY",
        providerReachable: null,
        authenticationValid: false,
        modelAvailable: null,
        latencyMs: 0,
        errorCode: "AI_PROVIDER_CREDENTIAL_MISSING"
      };
    try {
      if (connection.providerType === "OPENAI_COMPATIBLE") {
        const base = (connection.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const response = await this.http.execute(
          { method: "GET", url: `${base}/models`, timeoutMs: 8000 },
          { Authorization: `Bearer ${secrets.apiKey}` }
        );
        return classify(response.status, Date.now() - started);
      }
      const metadata = (connection.metadataJson ?? {}) as { apiVersion?: string };
      const apiVersion = metadata.apiVersion ?? "2024-02-01";
      if (!connection.baseUrl)
        return {
          status: "UNHEALTHY",
          providerReachable: false,
          authenticationValid: null,
          modelAvailable: null,
          latencyMs: 0,
          errorCode: "AI_PROVIDER_ENDPOINT_MISSING"
        };
      const response = await this.http.execute(
        {
          method: "GET",
          url: `${connection.baseUrl.replace(/\/$/, "")}/openai/deployments?api-version=${apiVersion}`,
          timeoutMs: 8000
        },
        { "api-key": secrets.apiKey }
      );
      return classify(response.status, Date.now() - started);
    } catch {
      return {
        status: "UNHEALTHY",
        providerReachable: false,
        authenticationValid: null,
        modelAvailable: null,
        latencyMs: Date.now() - started,
        errorCode: "AI_PROVIDER_UNAVAILABLE"
      };
    }
  }

  private async requireConnection(organizationId: string, id: string) {
    const row = await this.prisma.aiProviderConnection.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException("AI_PROVIDER_CONNECTION_NOT_FOUND");
    return row;
  }

  private decrypt(payload: unknown): Record<string, string> {
    try {
      return this.encryption.decrypt(payload as EncryptedPayload);
    } catch {
      return {};
    }
  }

  private assertProviderAllowed(type: "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI") {
    if (type === "DETERMINISTIC" && !this.security.allowDevelopmentImplementations)
      throw new BadRequestException("DEVELOPMENT_PROVIDER_NOT_ALLOWED");
  }

  /** Strips every secret-bearing field — this is the ONLY shape any controller/dashboard response
   *  may return for a connection. `credentialConfigured` is a boolean derived by actually
   *  decrypting and checking for the `apiKey` key, never a length/hint/suffix, and never just
   *  "does an encrypted payload exist" (an empty-secrets payload still encrypts to something). */
  private toSafeConnection(row: {
    id: string;
    organizationId: string;
    name: string;
    providerType: string;
    baseUrl: string | null;
    status: string;
    isDefault: boolean;
    metadataJson: unknown;
    lastHealthCheckAt: Date | null;
    lastHealthStatus: string;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
    encryptedCredentialJson: unknown;
    _count?: { modelProfiles: number };
  }) {
    const credentialConfigured = "apiKey" in this.decrypt(row.encryptedCredentialJson);
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      providerType: row.providerType,
      baseUrl: row.baseUrl,
      status: row.status,
      isDefault: row.isDefault,
      metadataJson: row.metadataJson,
      credentialConfigured,
      lastHealthCheckAt: row.lastHealthCheckAt,
      lastHealthStatus: row.lastHealthStatus,
      modelProfileCount: row._count?.modelProfiles ?? 0,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
}

interface ConnectionTestResult {
  status: "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "UNKNOWN";
  providerReachable: boolean | null;
  authenticationValid: boolean | null;
  modelAvailable: boolean | null;
  latencyMs: number;
  errorCode: string | null;
}

function classify(status: number, latencyMs: number): ConnectionTestResult {
  if (status === 200)
    return {
      status: "HEALTHY",
      providerReachable: true,
      authenticationValid: true,
      modelAvailable: null,
      latencyMs,
      errorCode: null
    };
  if (status === 401 || status === 403)
    return {
      status: "UNHEALTHY",
      providerReachable: true,
      authenticationValid: false,
      modelAvailable: null,
      latencyMs,
      errorCode: "AI_PROVIDER_AUTHENTICATION_FAILED"
    };
  if (status === 429)
    return {
      status: "DEGRADED",
      providerReachable: true,
      authenticationValid: true,
      modelAvailable: null,
      latencyMs,
      errorCode: "AI_PROVIDER_QUOTA_EXCEEDED"
    };
  if (status >= 500)
    return {
      status: "UNHEALTHY",
      providerReachable: true,
      authenticationValid: null,
      modelAvailable: null,
      latencyMs,
      errorCode: "AI_PROVIDER_UNAVAILABLE"
    };
  return {
    status: "UNHEALTHY",
    providerReachable: true,
    authenticationValid: null,
    modelAvailable: null,
    latencyMs,
    errorCode: "AI_PROVIDER_TEST_FAILED"
  };
}

