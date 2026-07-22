import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PluginAiProviderType } from "@prisma/client";
import {
  SECURITY_CONFIG,
  type SecurityConfig
} from "../identity/infrastructure/security/security-config";
import { PrismaService } from "../infrastructure/prisma/prisma.service";
import { withTimeout } from "../agents/agent.runtime";
import { PluginSecretsEncryptionService, type EncryptedPayload } from "../plugins/plugin.runtime";

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  usage?: { inputTokens?: number };
}
export interface EmbeddingProvider {
  readonly type: string;
  embedTexts(input: { texts: string[]; organizationId: string }): Promise<EmbeddingResult>;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly type = "DETERMINISTIC";
  constructor(private readonly dimensions = 64) {}
  async embedTexts(input: { texts: string[]; organizationId: string }): Promise<EmbeddingResult> {
    const vectors = input.texts.map((text) => deterministicVector(text, this.dimensions));
    return { vectors, model: "deterministic-knowledge-v1", dimensions: this.dimensions };
  }
}

class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly type: string,
    private readonly url: string,
    private readonly model: string,
    private readonly headers: Record<string, string>,
    private readonly timeoutMs: number
  ) {}
  async embedTexts(input: { texts: string[]; organizationId: string }): Promise<EmbeddingResult> {
    let response: Response;
    try {
      response = await withTimeout(
        fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body: JSON.stringify({ input: input.texts, model: this.model })
        }),
        this.timeoutMs,
        "EMBEDDING_PROVIDER_REQUEST_FAILED"
      );
    } catch {
      throw new BadRequestException("EMBEDDING_PROVIDER_REQUEST_FAILED");
    }
    if (!response.ok) throw new BadRequestException("EMBEDDING_PROVIDER_REQUEST_FAILED");
    const payload = (await response.json()) as unknown;
    const record = asRecord(payload);
    const data = Array.isArray(record.data) ? record.data : [];
    const vectors = data.map((entry) => asRecord(entry).embedding).filter(isNumberArray);
    if (vectors.length !== input.texts.length || !vectors.length)
      throw new BadRequestException("EMBEDDING_PROVIDER_RESPONSE_INVALID");
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions || vectors.some((vector) => vector.length !== dimensions))
      throw new BadRequestException("EMBEDDING_PROVIDER_RESPONSE_INVALID");
    const usage = asRecord(record.usage);
    return {
      vectors,
      model: this.model,
      dimensions,
      ...(typeof usage.prompt_tokens === "number"
        ? { usage: { inputTokens: usage.prompt_tokens } }
        : {})
    };
  }
}

@Injectable()
export class KnowledgeEmbeddingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: PluginSecretsEncryptionService,
    @Inject(SECURITY_CONFIG) private readonly security: SecurityConfig
  ) {}
  async embed(organizationId: string, texts: string[]): Promise<EmbeddingResult> {
    if (!texts.length || texts.length > 64)
      throw new BadRequestException("EMBEDDING_PROVIDER_REQUEST_FAILED");
    const provider = await this.provider(organizationId);
    const result = await provider.embedTexts({ texts, organizationId });
    if (
      result.vectors.length !== texts.length ||
      result.vectors.some((vector) => vector.some((value) => !Number.isFinite(value)))
    )
      throw new BadRequestException("EMBEDDING_PROVIDER_RESPONSE_INVALID");
    return result;
  }
  private async provider(organizationId: string): Promise<EmbeddingProvider> {
    const stored = await this.prisma.pluginAiConfiguration.findFirst({
      where: { organizationId },
      orderBy: { updatedAt: "desc" }
    });
    if (!stored) {
      if (this.security.allowDevelopmentImplementations)
        return new DeterministicEmbeddingProvider();
      throw new BadRequestException("EMBEDDING_PROVIDER_NOT_CONFIGURED");
    }
    const configuration = asRecord(stored.configuration);
    if (stored.providerType === PluginAiProviderType.DETERMINISTIC) {
      if (!this.security.allowDevelopmentImplementations)
        throw new BadRequestException("EMBEDDING_PROVIDER_NOT_CONFIGURED");
      return new DeterministicEmbeddingProvider();
    }
    const secrets = this.encryption.decrypt(stored.encryptedSecrets as unknown as EncryptedPayload);
    if (!secrets.apiKey) throw new BadRequestException("EMBEDDING_PROVIDER_NOT_CONFIGURED");
    const timeoutMs =
      typeof configuration.timeoutMs === "number" ? configuration.timeoutMs : 30_000;
    if (stored.providerType === PluginAiProviderType.AZURE_OPENAI) {
      const endpoint = string(configuration.endpoint),
        deployment = string(configuration.embeddingDeployment ?? configuration.deploymentName),
        apiVersion = string(configuration.apiVersion);
      if (!endpoint || !deployment || !apiVersion)
        throw new BadRequestException("EMBEDDING_PROVIDER_NOT_CONFIGURED");
      return new HttpEmbeddingProvider(
        "AZURE_OPENAI",
        `${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`,
        deployment,
        { "api-key": secrets.apiKey },
        timeoutMs
      );
    }
    const model = string(configuration.embeddingModel);
    if (!model) throw new BadRequestException("EMBEDDING_PROVIDER_NOT_CONFIGURED");
    const base = string(configuration.baseUrl) || "https://api.openai.com/v1";
    return new HttpEmbeddingProvider(
      "OPENAI_COMPATIBLE",
      `${base.replace(/\/$/, "")}/embeddings`,
      model,
      { Authorization: `Bearer ${secrets.apiKey}` },
      timeoutMs
    );
  }
}

function deterministicVector(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash.readUInt32BE(0) % dimensions;
    vector[index] = (vector[index] ?? 0) + ((hash[4] ?? 0) % 2 ? 1 : -1);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number")
  );
}
function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
