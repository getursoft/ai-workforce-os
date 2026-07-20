export type JsonSchema = Readonly<Record<string, unknown>>;
export type ConnectorAuthType =
  "NONE" | "API_KEY" | "BEARER_TOKEN" | "BASIC_AUTH" | "OAUTH2" | "CUSTOM";
export type ConnectorRiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type ConnectorOperationType = "READ" | "WRITE";

export interface ConnectorToolManifest {
  name: string;
  displayName: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  requiredCapability: string;
  operationType: ConnectorOperationType;
  riskLevel: ConnectorRiskLevel;
  timeoutMs: number;
}

export interface ConnectorEventManifest {
  type: string;
  payloadSchema: JsonSchema;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  authType: ConnectorAuthType;
  configurationSchema: JsonSchema;
  credentialSchema: JsonSchema;
  capabilities: readonly string[];
  tools: readonly ConnectorToolManifest[];
  events?: readonly ConnectorEventManifest[];
}

export interface ConnectorContext {
  organizationId: string;
  installationId: string;
  actorId?: string;
  requestId: string;
  configuration: Readonly<Record<string, unknown>>;
  credentials: Readonly<Record<string, string>>;
  grantedCapabilities: ReadonlySet<string>;
}

export interface ConnectorHealth {
  status:
    | "UNKNOWN"
    | "READY"
    | "DEGRADED"
    | "FAILED"
    | "AUTH_FAILED"
    | "EXPIRED"
    | "RATE_LIMITED"
    | "DISCONNECTED";
  message?: string;
  checkedAt: string;
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  initialize?(context: ConnectorContext): Promise<void>;
  validateConfiguration?(configuration: Record<string, unknown>): Promise<void>;
  validateCredentials?(credentials: Record<string, string>): Promise<void>;
  testConnection(context: ConnectorContext): Promise<ConnectorHealth>;
  healthCheck(context: ConnectorContext): Promise<ConnectorHealth>;
  executeTool(
    name: string,
    input: Record<string, unknown>,
    context: ConnectorContext
  ): Promise<unknown>;
  disconnect?(context: ConnectorContext): Promise<void>;
  refreshAuthentication?(context: ConnectorContext): Promise<Record<string, string>>;
  verifyWebhookSignature?(
    headers: Readonly<Record<string, string>>,
    rawPayload: Uint8Array,
    context: ConnectorContext
  ): Promise<boolean>;
  handleEvent?(
    type: string,
    payload: Record<string, unknown>,
    context: ConnectorContext
  ): Promise<void>;
}
