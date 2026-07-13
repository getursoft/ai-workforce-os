import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import semver from "semver";
import type { BasePlugin, PluginManifest } from "@ai-workforce-os/plugin-sdk";

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

export class PluginValidationError extends Error {
  constructor(readonly details: readonly string[]) {
    super("Plugin validation failed");
  }
}

export class ManifestValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  validate(value: unknown): PluginManifest {
    if (!isRecord(value)) throw new PluginValidationError(["manifest must be an object"]);
    const required = [
      "id",
      "name",
      "version",
      "displayName",
      "description",
      "author",
      "entryPoint",
      "permissions",
      "tools"
    ];
    const errors: string[] = [];
    for (const key of required) if (!(key in value)) errors.push(`${key} is required`);
    for (const key of [
      "id",
      "name",
      "version",
      "displayName",
      "description",
      "author",
      "entryPoint"
    ])
      if (typeof value[key] !== "string" || !value[key].trim())
        errors.push(`${key} must be a non-blank string`);
    if (typeof value.id === "string" && !IDENTIFIER.test(value.id))
      errors.push("id must be a slug-like identifier");
    if (typeof value.entryPoint === "string" && !IDENTIFIER.test(value.entryPoint))
      errors.push("entryPoint must be a safe identifier");
    if (typeof value.version === "string" && !semver.valid(value.version))
      errors.push("version must be valid semantic version");
    if (
      !Array.isArray(value.permissions) ||
      value.permissions.some((x) => typeof x !== "string" || !x.trim())
    )
      errors.push("permissions must be non-blank strings");
    else if (new Set(value.permissions).size !== value.permissions.length)
      errors.push("permissions must be unique");
    if (!Array.isArray(value.tools)) errors.push("tools must be an array");
    else {
      const names: string[] = [];
      for (const tool of value.tools) {
        if (
          !isRecord(tool) ||
          typeof tool.name !== "string" ||
          !tool.name.trim() ||
          typeof tool.description !== "string" ||
          !tool.description.trim()
        )
          errors.push("tools must contain name and description");
        else names.push(tool.name);
      }
      if (new Set(names).size !== names.length) errors.push("tool names must be unique");
    }
    const allowed = new Set([...required, "configSchema"]);
    for (const key of Object.keys(value))
      if (!allowed.has(key) || forbidden.has(key))
        errors.push(`unsupported manifest field: ${key}`);
    if (value.configSchema !== undefined) {
      if (!isRecord(value.configSchema)) errors.push("configSchema must be an object");
      else
        try {
          this.ajv.compile(value.configSchema);
        } catch {
          errors.push("configSchema is invalid");
        }
    }
    if (errors.length) throw new PluginValidationError(errors);
    return value as unknown as PluginManifest;
  }
}

export class ConfigurationSchemaValidator {
  private readonly ajv = new Ajv({ allErrors: true, strict: true });
  private readonly cache = new Map<string, ValidateFunction>();
  validate(cacheKey: string, schema: Record<string, unknown> | undefined, config: unknown): void {
    rejectDangerous(config);
    if (!schema) return;
    let validate = this.cache.get(cacheKey);
    if (!validate) {
      try {
        validate = this.ajv.compile(schema);
      } catch {
        throw new PluginValidationError(["configuration schema is invalid"]);
      }
      this.cache.set(cacheKey, validate);
    }
    if (!validate(config))
      throw new PluginValidationError(
        (validate.errors ?? []).map((x) => `${x.instancePath || "/"} ${x.message ?? "is invalid"}`)
      );
  }
  invalidate(cacheKey: string): void {
    this.cache.delete(cacheKey);
  }
}

export interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}
export class PluginSecretsEncryptionService {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("PLUGIN_SECRETS_KEY_INVALID");
  }
  encrypt(secrets: Record<string, string>): EncryptedPayload {
    rejectDangerous(secrets);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), "utf8"),
      cipher.final()
    ]);
    return {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }
  decrypt(payload: EncryptedPayload): Record<string, string> {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(payload.iv, "base64"));
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(payload.ciphertext, "base64")),
          decipher.final()
        ]).toString("utf8")
      ) as Record<string, string>;
    } catch {
      throw new Error("PLUGIN_SECRETS_ENCRYPTION_FAILED");
    }
  }
}

export class PluginRegistry {
  private readonly entries = new Map<string, BasePlugin>();
  register(organizationId: string, slug: string, plugin: BasePlugin): void {
    const key = `${organizationId}:${slug}`;
    if (this.entries.has(key)) throw new Error("PLUGIN_REGISTRATION_FAILED");
    this.entries.set(key, plugin);
  }
  unregister(organizationId: string, slug: string): void {
    this.entries.delete(`${organizationId}:${slug}`);
  }
  has(organizationId: string, slug: string): boolean {
    return this.entries.has(`${organizationId}:${slug}`);
  }
  lookup(organizationId: string, slug: string): BasePlugin | undefined {
    return this.entries.get(`${organizationId}:${slug}`);
  }
  list(organizationId: string): BasePlugin[] {
    return [...this.entries]
      .filter(([key]) => key.startsWith(`${organizationId}:`))
      .map(([, plugin]) => plugin);
  }
  async health(organizationId: string, slug: string) {
    const plugin = this.lookup(organizationId, slug);
    return plugin
      ? plugin.health()
      : { status: "DISABLED" as const, checkedAt: new Date().toISOString() };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rejectDangerous(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new PluginValidationError(["unsafe object key"]);
    if (isRecord(child)) rejectDangerous(child);
  }
}
