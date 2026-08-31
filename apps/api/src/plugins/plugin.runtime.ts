import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import semver from "semver";
import {
  PluginHealthStatus,
  PluginPermission,
  type BasePlugin,
  type PluginContext,
  type PluginEvent,
  type PluginManifest,
  type PluginServices
} from "@ai-workforce-os/plugin-sdk";

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const permissions = new Set(Object.values(PluginPermission));

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
    if (typeof value.entryPoint === "string" && !safeEntry(value.entryPoint))
      errors.push("entryPoint must be a safe relative JavaScript path or built-in identifier");
    if (typeof value.version === "string" && !semver.valid(value.version))
      errors.push("version must be valid semantic version");
    if (
      !Array.isArray(value.permissions) ||
      value.permissions.some((x) => typeof x !== "string" || !x.trim())
    )
      errors.push("permissions must be non-blank strings");
    else if (new Set(value.permissions).size !== value.permissions.length)
      errors.push("permissions must be unique");
    else if (value.permissions.some((x) => !permissions.has(x as PluginPermission)))
      errors.push("permissions contain an unsupported value");
    if (value.capabilities !== undefined) {
      if (
        !Array.isArray(value.capabilities) ||
        value.capabilities.some((x) => typeof x !== "string" || !x.trim())
      )
        errors.push("capabilities must be non-blank strings");
      else if (new Set(value.capabilities).size !== value.capabilities.length)
        errors.push("capabilities must be unique");
    }
    if (value.routing !== undefined) {
      if (!isRecord(value.routing)) errors.push("routing must be an object");
      else {
        const routing = value.routing;
        const stringFields = ["employeeKey", "employeeType", "displayName", "summary"];
        const requiredArrayFields = [
          "domains",
          "capabilities",
          "intents",
          "examples",
          "aliases",
          "keywords"
        ];
        const optionalArrayFields = [
          "negativeCapabilities",
          "supportedActions",
          "channelEligibility"
        ];
        const arrayFields = [...requiredArrayFields, ...optionalArrayFields];
        const requiredRouting = ["employeeKey", ...requiredArrayFields];
        for (const key of requiredRouting)
          if (!(key in routing)) errors.push(`routing.${key} is required`);
        for (const key of stringFields)
          if (
            routing[key] !== undefined &&
            (typeof routing[key] !== "string" || !routing[key].trim())
          )
            errors.push(`routing.${key} must be a non-blank string`);
        for (const key of arrayFields) {
          const values = routing[key];
          if (values === undefined && optionalArrayFields.includes(key)) continue;
          if (
            !Array.isArray(values) ||
            values.some((item) => typeof item !== "string" || !item.trim())
          )
            errors.push(`routing.${key} must contain non-blank strings`);
          else if (new Set(values).size !== values.length)
            errors.push(`routing.${key} must be unique`);
        }
        if (
          Array.isArray(routing.channelEligibility) &&
          routing.channelEligibility.some(
            (channel) => !["WEB", "WHATSAPP", "VOICE"].includes(channel)
          )
        )
          errors.push("routing.channelEligibility contains an unsupported channel");
        for (const key of ["delegationEnabled", "enabled"])
          if (routing[key] !== undefined && typeof routing[key] !== "boolean")
            errors.push(`routing.${key} must be boolean`);
        if (routing.priority !== undefined && !Number.isInteger(routing.priority))
          errors.push("routing.priority must be an integer");
        const allowedRouting = new Set([
          ...stringFields,
          ...arrayFields,
          "delegationEnabled",
          "priority",
          "enabled"
        ]);
        for (const key of Object.keys(routing))
          if (!allowedRouting.has(key) || forbidden.has(key))
            errors.push(`unsupported routing field: ${key}`);
      }
    }
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
    const allowed = new Set([...required, "configSchema", "capabilities", "routing"]);
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
  version: number;
  iv: string;
  tag: string;
  ciphertext: string;
}
/**
 * Sprint 5.0 Phase 7: `previousKey`/`previousVersion` support a rotation window — pass them (or leave them
 * undefined) without changing any existing call site. New encryptions always use `key`/`currentVersion`;
 * decrypting a payload recorded under `previousVersion` still works until it's re-encrypted under the
 * current key. A payload whose version matches neither key throws a distinct, diagnosable error rather
 * than the generic decryption-failure message.
 */
export class PluginSecretsEncryptionService {
  constructor(
    private readonly key: Buffer,
    private readonly previousKey?: Buffer,
    private readonly currentVersion: number = 1,
    private readonly previousVersion?: number
  ) {
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
      version: this.currentVersion,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
  }
  decrypt(payload: EncryptedPayload): Record<string, string> {
    const key =
      payload.version === this.currentVersion
        ? this.key
        : this.previousKey && payload.version === this.previousVersion
          ? this.previousKey
          : undefined;
    if (!key) throw new Error("PLUGIN_SECRETS_ENCRYPTION_KEY_VERSION_UNKNOWN");
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
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

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  create(): BasePlugin;
}
export interface DiscoveryResult {
  plugins: readonly DiscoveredPlugin[];
  errors: readonly { plugin: string; code: string; details: readonly string[] }[];
}
export class PluginDiscovery {
  constructor(
    private readonly baseDirectory: string,
    private readonly validator: ManifestValidator
  ) {}
  async discover(): Promise<DiscoveryResult> {
    const plugins: DiscoveredPlugin[] = [],
      errors: DiscoveryResult["errors"][number][] = [],
      ids = new Set<string>();
    let directories: string[] = [];
    try {
      directories = (await readdir(this.baseDirectory, { withFileTypes: true }))
        .filter((x) => x.isDirectory())
        .map((x) => x.name)
        .sort();
    } catch {
      return {
        plugins,
        errors: [
          {
            plugin: "<directory>",
            code: "PLUGIN_LOAD_FAILED",
            details: ["Plugin directory is unavailable"]
          }
        ]
      };
    }
    for (const directory of directories) {
      try {
        const root = await realpath(resolve(this.baseDirectory, directory)),
          manifestPath = resolve(root, "plugin.json");
        const manifest = this.validator.validate(JSON.parse(await readFile(manifestPath, "utf8")));
        if (ids.has(manifest.id)) throw new PluginValidationError(["duplicate plugin id"]);
        ids.add(manifest.id);
        const entry = resolve(root, manifest.entryPoint),
          rel = relative(root, entry);
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new PluginValidationError(["entry path escapes plugin directory"]);
        const loaded = await import(pathToFileURL(entry).href);
        const Candidate = loaded.DummyEchoPlugin ?? loaded.default;
        if (typeof Candidate !== "function")
          throw new PluginValidationError(["entry module does not export a plugin constructor"]);
        const instance = new Candidate() as BasePlugin;
        if (!instance.manifest || typeof instance.health !== "function")
          throw new PluginValidationError(["entry module does not implement the plugin contract"]);
        plugins.push({ manifest, create: () => new Candidate() as BasePlugin });
      } catch (error) {
        errors.push({
          plugin: directory,
          code: "PLUGIN_LOAD_FAILED",
          details:
            error instanceof PluginValidationError ? error.details : ["Plugin could not be loaded"]
        });
      }
    }
    return { plugins, errors };
  }
}

export class PluginPermissionError extends Error {
  constructor(readonly permission: PluginPermission) {
    super("PLUGIN_PERMISSION_DENIED");
  }
}
export function createPluginServices(granted: ReadonlySet<PluginPermission>): PluginServices {
  const service = (permission: PluginPermission) => Object.freeze({ permission });
  return Object.freeze({
    ...(granted.has(PluginPermission.LLM) ? { llm: service(PluginPermission.LLM) } : {}),
    ...(granted.has(PluginPermission.MEMORY)
      ? {
          memory: {
            ...service(PluginPermission.MEMORY),
            async get() {
              return undefined;
            },
            async set() {}
          }
        }
      : {}),
    ...(granted.has(PluginPermission.EVENTS) ? { events: service(PluginPermission.EVENTS) } : {}),
    ...(granted.has(PluginPermission.TOOLS) ? { tools: service(PluginPermission.TOOLS) } : {}),
    ...(granted.has(PluginPermission.FILES) ? { files: service(PluginPermission.FILES) } : {}),
    ...(granted.has(PluginPermission.EMAIL) ? { email: service(PluginPermission.EMAIL) } : {}),
    ...(granted.has(PluginPermission.CALENDAR)
      ? { calendar: service(PluginPermission.CALENDAR) }
      : {}),
    ...(granted.has(PluginPermission.CRM) ? { crm: service(PluginPermission.CRM) } : {}),
    ...(granted.has(PluginPermission.VOICE) ? { voice: service(PluginPermission.VOICE) } : {}),
    ...(granted.has(PluginPermission.SEARCH) ? { search: service(PluginPermission.SEARCH) } : {})
  });
}
export function requirePluginService<T>(service: T | undefined, permission: PluginPermission): T {
  if (!service) throw new PluginPermissionError(permission);
  return service;
}

export class PluginLifecycleEngine {
  constructor(private readonly timeoutMs = 5000) {}
  async install(plugin: BasePlugin, context: PluginContext) {
    await this.run(plugin.install?.bind(plugin), context);
  }
  async enable(plugin: BasePlugin, context: PluginContext) {
    await this.run(plugin.enable?.bind(plugin), context);
    await this.run(plugin.start?.bind(plugin), context);
  }
  async disable(plugin: BasePlugin, context: PluginContext) {
    await this.run(plugin.stop?.bind(plugin), context);
    await this.run(plugin.disable?.bind(plugin), context);
  }
  async uninstall(plugin: BasePlugin, context: PluginContext) {
    await this.disable(plugin, context);
    await this.run(plugin.uninstall?.bind(plugin), context);
  }
  async health(plugin: BasePlugin, context: PluginContext) {
    if (!plugin.health)
      return { status: PluginHealthStatus.UNKNOWN, checkedAt: new Date().toISOString() };
    return this.timeout(plugin.health(context));
  }
  private async run(
    hook: ((context: PluginContext) => Promise<void>) | undefined,
    context: PluginContext
  ) {
    if (hook) await this.timeout(hook(context));
  }
  private timeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("PLUGIN_OPERATION_TIMEOUT")), this.timeoutMs);
      void operation.then(
        (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }
}

type EventHandler = (event: PluginEvent) => Promise<void>;
export class PluginEventBus {
  private readonly handlers = new Map<string, Map<string, EventHandler>>();
  constructor(private readonly timeoutMs = 5000) {}
  subscribe(organizationId: string, pluginId: string, type: string, handler: EventHandler) {
    const key = `${organizationId}:${type}`,
      bucket = this.handlers.get(key) ?? new Map();
    if (bucket.has(pluginId)) throw new Error("PLUGIN_DUPLICATE_SUBSCRIPTION");
    bucket.set(pluginId, handler);
    this.handlers.set(key, bucket);
  }
  unsubscribe(organizationId: string, pluginId: string) {
    for (const [key, bucket] of this.handlers)
      if (key.startsWith(`${organizationId}:`)) bucket.delete(pluginId);
  }
  async publish(event: PluginEvent) {
    const bucket = this.handlers.get(`${event.organizationId}:${event.type}`);
    if (!bucket) return;
    await Promise.allSettled(
      [...bucket.values()].map((handler) =>
        Promise.race([
          handler(event),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("PLUGIN_OPERATION_TIMEOUT")), this.timeoutMs)
          )
        ])
      )
    );
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
function safeEntry(value: string): boolean {
  return (
    IDENTIFIER.test(value) ||
    (!isAbsolute(value) && !value.includes("..") && /^[a-zA-Z0-9_./-]+\.js$/.test(value))
  );
}
