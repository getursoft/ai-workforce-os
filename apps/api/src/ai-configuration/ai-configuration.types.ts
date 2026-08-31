import type { AiProfilePurpose } from "@prisma/client";

/** Where a resolved AI configuration came from — attached to observability spans and usage
 *  metadata so a trace can show e.g. "Receptionist / ROUTING / OpenAI Production / Receptionist
 *  Router / EMPLOYEE_PURPOSE_PROFILE" without re-deriving the precedence walk after the fact. */
export type AiConfigResolutionSource =
  | "EMPLOYEE_PURPOSE_PROFILE"
  | "EMPLOYEE_DEFAULT_PROFILE"
  | "ORG_PURPOSE_DEFAULT"
  | "ORG_DEFAULT"
  | "LEGACY_PLUGIN_CONFIG"
  | "PLATFORM_DEFAULT";

export interface ResolveAiConfigurationInput {
  organizationId: string;
  pluginInstallationId: string;
  purpose?: AiProfilePurpose;
}

/** Safe, secret-free configuration metadata — this is what controllers/dashboard responses may
 *  return. Never includes a decrypted API key; `credentialReference` is only an opaque id/label
 *  (the provider connection id) so a caller can tell which stored credential would be used
 *  without ever seeing its value. */
export interface ResolvedAiConfiguration {
  providerConnectionId: string | null;
  modelProfileId: string | null;
  providerType: "DETERMINISTIC" | "OPENAI_COMPATIBLE" | "AZURE_OPENAI";
  baseUrl: string | null;
  endpoint: string | null;
  deploymentName: string | null;
  apiVersion: string | null;
  model: string | null;
  embeddingModel: string | null;
  embeddingDeployment: string | null;
  temperature: number | null;
  maxOutputTokens: number | null;
  timeoutMs: number;
  additionalSettings: Record<string, unknown>;
  credentialReference: string | null;
  resolutionSource: AiConfigResolutionSource;
}
