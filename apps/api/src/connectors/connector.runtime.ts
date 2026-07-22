import Ajv, { type ValidateFunction } from "ajv";
import semver from "semver";
import type {
  Connector,
  ConnectorContext,
  ConnectorManifest
} from "@ai-workforce-os/connector-sdk";

function createAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat("uri", {
    type: "string",
    validate(value: string) {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }
  });
  ajv.addFormat("email", {
    type: "string",
    validate: (value: string) => value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  });
  return ajv;
}

export class ConnectorValidationError extends Error {
  constructor(readonly details: readonly string[]) {
    super("CONNECTOR_MANIFEST_INVALID");
  }
}

export class ConnectorManifestValidator {
  private readonly ajv = createAjv();
  validate(value: unknown): ConnectorManifest {
    if (!isRecord(value)) throw new ConnectorValidationError(["manifest must be an object"]);
    const errors: string[] = [];
    const id = string(value.id);
    if (!/^[a-z][a-z0-9-]{1,99}$/.test(id)) errors.push("id is invalid");
    if (!string(value.name).trim()) errors.push("name is required");
    if (!semver.valid(string(value.version))) errors.push("version must be semantic");
    if (
      !["NONE", "API_KEY", "BEARER_TOKEN", "BASIC_AUTH", "OAUTH2", "CUSTOM"].includes(
        string(value.authType)
      )
    )
      errors.push("authType is unsupported");
    const capabilities = stringArray(value.capabilities, "capabilities", errors);
    if (new Set(capabilities).size !== capabilities.length)
      errors.push("capabilities must be unique");
    const tools = Array.isArray(value.tools) ? value.tools : [];
    if (!Array.isArray(value.tools)) errors.push("tools must be an array");
    const toolNames = new Set<string>();
    for (const raw of tools) {
      if (!isRecord(raw) || !string(raw.name) || !isRecord(raw.inputSchema)) {
        errors.push("each tool requires a name and inputSchema");
        continue;
      }
      if (toolNames.has(string(raw.name))) errors.push("tool names must be unique");
      toolNames.add(string(raw.name));
      if (!capabilities.includes(string(raw.requiredCapability)))
        errors.push(`tool ${string(raw.name)} requires an undeclared capability`);
      this.compile(raw.inputSchema, errors, `tool ${string(raw.name)} inputSchema`);
    }
    this.compile(value.configurationSchema, errors, "configurationSchema");
    this.compile(value.credentialSchema, errors, "credentialSchema");
    if (errors.length) throw new ConnectorValidationError(errors);
    return value as unknown as ConnectorManifest;
  }
  private compile(value: unknown, errors: string[], name: string) {
    if (!isRecord(value)) {
      errors.push(`${name} must be an object`);
      return;
    }
    try {
      this.ajv.compile(value);
    } catch {
      errors.push(`${name} is invalid`);
    }
  }
}

export class ConnectorSchemaValidator {
  private readonly ajv = createAjv();
  private readonly validators = new Map<string, ValidateFunction>();
  validate(key: string, schema: Record<string, unknown>, value: unknown): void {
    let validator = this.validators.get(key);
    if (!validator) {
      validator = this.ajv.compile(schema);
      this.validators.set(key, validator);
    }
    if (!validator(value))
      throw new ConnectorValidationError(
        (validator.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`)
      );
  }
}

export class ConnectorRegistry {
  private readonly definitions = new Map<string, Connector>();
  register(connector: Connector): void {
    if (this.definitions.has(connector.manifest.id))
      throw new Error("CONNECTOR_ALREADY_REGISTERED");
    this.definitions.set(connector.manifest.id, connector);
  }
  resolve(key: string): Connector | undefined {
    return this.definitions.get(key);
  }
  list(): Connector[] {
    return [...this.definitions.values()];
  }
}

export async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("CONNECTOR_TOOL_TIMEOUT")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function connectorContext(input: {
  organizationId: string;
  installationId: string;
  actorId?: string;
  requestId: string;
  configuration: Record<string, unknown>;
  credentials: Record<string, string>;
  grantedCapabilities: string[];
}): ConnectorContext {
  return {
    organizationId: input.organizationId,
    installationId: input.installationId,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    requestId: input.requestId,
    configuration: Object.freeze({ ...input.configuration }),
    credentials: Object.freeze({ ...input.credentials }),
    grantedCapabilities: new Set(input.grantedCapabilities)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function stringArray(value: unknown, name: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${name} must be a string array`);
    return [];
  }
  return value as string[];
}
