/**
 * Sprint 5.0 — strict environment configuration (Phase 2).
 *
 * A schema-based validator for every configuration group the platform needs. Validation is explicit and
 * readable: each variable declares a type, whether it is required in a given environment, and a validator.
 * `loadAppConfig` is called once at bootstrap and throws a clear error before the application starts when
 * a required variable is missing or malformed — production fails fast. Secret values are never returned
 * in the resolved config object in a way that reaches logs; they are exposed only via the SecretProvider.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`CONFIGURATION_INVALID: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export type EnvGroup =
  | "app"
  | "database"
  | "auth"
  | "encryption"
  | "storage"
  | "queue"
  | "email"
  | "meta"
  | "observability"
  | "billing"
  | "secrets";

export interface FieldSpec {
  name: string;
  group: EnvGroup;
  type: "string" | "number" | "boolean" | "url" | "duration";
  /** Required in these environments (development/test always use defaults). */
  requiredIn?: Array<"staging" | "production">;
  /** Secret values are masked in any diagnostics. */
  secret?: boolean;
  min?: number;
  max?: number;
  default?: string;
  oneOf?: string[];
  pattern?: RegExp;
  mask?: "full" | "tail" | "none";
}

function parseNumber(value: string, field: FieldSpec): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field.name} must be a number`);
  if (field.min !== undefined && parsed < field.min)
    throw new Error(`${field.name} must be >= ${field.min}`);
  if (field.max !== undefined && parsed > field.max)
    throw new Error(`${field.name} must be <= ${field.max}`);
  return parsed;
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("must be true or false");
}

/** Parses "500ms", "30s", "5m", "1h", "2d" into milliseconds. */
export function parseDurationMs(value: string, name: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error(`${name} must be a duration like 30s, 5m, 1h`);
  const amountText = match[1];
  if (amountText === undefined) throw new Error(`${name} must be a duration like 30s, 5m, 1h`);
  const amount = Number(amountText);
  const unit = match[2] ?? "ms";
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
  };
  const multiplier = multipliers[unit];
  if (multiplier === undefined) throw new Error(`${name} must be a duration like 30s, 5m, 1h`);
  return amount * multiplier;
}

export const DEFAULT_FIELDS: FieldSpec[] = [
  // ------------------------------------------------------------------ Application
  {
    name: "NODE_ENV",
    group: "app",
    type: "string",
    default: "development",
    oneOf: ["development", "test", "staging", "production"]
  },
  {
    name: "APP_ENV",
    group: "app",
    type: "string",
    default: "development",
    oneOf: ["development", "test", "staging", "production"]
  },
  { name: "API_PORT", group: "app", type: "number", default: "4000", min: 1, max: 65_535 },
  { name: "API_PUBLIC_URL", group: "app", type: "url", requiredIn: ["production", "staging"] },
  { name: "WEB_APP_URL", group: "app", type: "url", requiredIn: ["production", "staging"] },
  {
    name: "PLATFORM_OWNER_EMAIL",
    group: "app",
    type: "string",
    default: "krpandey25646@gmail.com"
  },
  { name: "PLUGIN_DIRECTORY", group: "app", type: "string", default: "" },
  { name: "CORS_ALLOWED_ORIGINS", group: "app", type: "string", default: "" },
  {
    name: "PROCESS_ROLE",
    group: "app",
    type: "string",
    default: "all",
    oneOf: ["all", "api", "scheduler", "workforce-worker", "channel-worker", "maintenance"]
  },
  { name: "TRUST_PROXY", group: "app", type: "boolean", default: "false" },
  { name: "RECEPTIONIST_VOICE_ENABLED", group: "app", type: "boolean", default: "false" },
  // ------------------------------------------------------------------ Database
  {
    name: "DATABASE_URL",
    group: "database",
    type: "string",
    requiredIn: ["production", "staging"],
    secret: true,
    mask: "none"
  },
  { name: "DATABASE_POOL_MIN", group: "database", type: "number", default: "2", min: 1, max: 100 },
  { name: "DATABASE_POOL_MAX", group: "database", type: "number", default: "10", min: 1, max: 200 },
  {
    name: "DATABASE_STATEMENT_TIMEOUT_MS",
    group: "database",
    type: "number",
    default: "30000",
    min: 100,
    max: 600_000
  },
  {
    name: "DATABASE_SLOW_QUERY_MS",
    group: "database",
    type: "number",
    default: "500",
    min: 1,
    max: 60_000
  },
  {
    name: "DATABASE_TRANSACTION_TIMEOUT_MS",
    group: "database",
    type: "number",
    default: "30000",
    min: 100,
    max: 600_000
  },
  // ------------------------------------------------------------------ Authentication
  {
    name: "JWT_ACCESS_SECRET",
    group: "auth",
    type: "string",
    requiredIn: ["production", "staging"],
    secret: true
  },
  {
    name: "REFRESH_TOKEN_PEPPER",
    group: "auth",
    type: "string",
    requiredIn: ["production", "staging"],
    secret: true
  },
  {
    name: "API_KEY_PEPPER",
    group: "auth",
    type: "string",
    requiredIn: ["production", "staging"],
    secret: true
  },
  {
    name: "JWT_ACCESS_EXPIRES_IN_SECONDS",
    group: "auth",
    type: "number",
    default: "900",
    min: 1,
    max: 86_400
  },
  {
    name: "REFRESH_TOKEN_EXPIRES_IN_SECONDS",
    group: "auth",
    type: "number",
    default: "2592000",
    min: 1,
    max: 31_536_000
  },
  {
    name: "JWT_ACCESS_ISSUER",
    group: "auth",
    type: "string",
    requiredIn: ["production", "staging"]
  },
  {
    name: "JWT_ACCESS_AUDIENCE",
    group: "auth",
    type: "string",
    requiredIn: ["production", "staging"]
  },
  { name: "COOKIE_DOMAIN", group: "auth", type: "string", default: "" },
  { name: "COOKIE_SECURE", group: "auth", type: "boolean", default: "true" },
  {
    name: "COOKIE_SAME_SITE",
    group: "auth",
    type: "string",
    default: "lax",
    oneOf: ["lax", "strict", "none"]
  },
  {
    name: "PASSWORD_HASH_MEMORY_COST",
    group: "auth",
    type: "number",
    default: "65536",
    min: 8192,
    max: 1_048_576
  },
  { name: "PASSWORD_HASH_TIME_COST", group: "auth", type: "number", default: "3", min: 1, max: 10 },
  {
    name: "PASSWORD_HASH_PARALLELISM",
    group: "auth",
    type: "number",
    default: "1",
    min: 1,
    max: 16
  },
  {
    name: "ACCOUNT_LOCKOUT_MAX_ATTEMPTS",
    group: "auth",
    type: "number",
    default: "5",
    min: 1,
    max: 20
  },
  {
    name: "ACCOUNT_LOCKOUT_DURATION_SECONDS",
    group: "auth",
    type: "number",
    default: "900",
    min: 1,
    max: 86_400
  },
  // ------------------------------------------------------------------ Encryption
  // PLATFORM_ENCRYPTION_KEY is reserved for future platform-wide encryption needs beyond plugin/connector
  // secrets — no consumer reads it yet, so it is intentionally NOT requiredIn production/staging (an
  // unused required secret would only block deploys for no benefit). PLUGIN_SECRETS_ENCRYPTION_KEY is the
  // one actually in use today (PluginSecretsEncryptionService), together with SECRET_KEY_VERSION and the
  // optional PLUGIN_SECRETS_ENCRYPTION_KEY_PREVIOUS/SECRET_KEY_VERSION_PREVIOUS rotation pair.
  { name: "PLATFORM_ENCRYPTION_KEY", group: "encryption", type: "string", secret: true },
  {
    name: "PLUGIN_SECRETS_ENCRYPTION_KEY",
    group: "encryption",
    type: "string",
    requiredIn: ["production", "staging"],
    secret: true
  },
  { name: "SECRET_KEY_VERSION", group: "encryption", type: "string", default: "1" },
  {
    name: "PLUGIN_SECRETS_ENCRYPTION_KEY_PREVIOUS",
    group: "encryption",
    type: "string",
    secret: true
  },
  { name: "SECRET_KEY_VERSION_PREVIOUS", group: "encryption", type: "string", default: "1" },
  // ------------------------------------------------------------------ Storage
  {
    name: "STORAGE_PROVIDER",
    group: "storage",
    type: "string",
    default: "local",
    oneOf: ["local", "s3"]
  },
  { name: "S3_ENDPOINT", group: "storage", type: "string", default: "" },
  { name: "S3_REGION", group: "storage", type: "string", default: "us-east-1" },
  { name: "S3_BUCKET", group: "storage", type: "string", default: "" },
  { name: "S3_ACCESS_KEY_ID", group: "storage", type: "string", default: "", secret: true },
  { name: "S3_SECRET_ACCESS_KEY", group: "storage", type: "string", default: "", secret: true },
  { name: "S3_FORCE_PATH_STYLE", group: "storage", type: "boolean", default: "true" },
  {
    name: "S3_SIGNED_URL_EXPIRY_SECONDS",
    group: "storage",
    type: "number",
    default: "300",
    min: 30,
    max: 3600
  },
  {
    name: "KNOWLEDGE_STORAGE_PATH",
    group: "storage",
    type: "string",
    default: "./storage/knowledge"
  },
  {
    name: "OBJECT_STORAGE_LOCAL_PATH",
    group: "storage",
    type: "string",
    default: "./storage/objects"
  },
  {
    name: "MAX_UPLOAD_BYTES",
    group: "storage",
    type: "number",
    default: String(10 * 1024 * 1024),
    min: 1024
  },
  {
    name: "KNOWLEDGE_MAX_FILE_SIZE_MB",
    group: "storage",
    type: "number",
    default: "10",
    min: 1,
    max: 50
  },
  {
    name: "KNOWLEDGE_CHUNK_TARGET_TOKENS",
    group: "storage",
    type: "number",
    default: "500",
    min: 400,
    max: 600
  },
  {
    name: "KNOWLEDGE_CHUNK_OVERLAP_TOKENS",
    group: "storage",
    type: "number",
    default: "100",
    min: 80,
    max: 120
  },
  {
    name: "KNOWLEDGE_SEARCH_CANDIDATE_LIMIT",
    group: "storage",
    type: "number",
    default: "1000",
    min: 10,
    max: 5000
  },
  {
    name: "KNOWLEDGE_SEARCH_DEFAULT_TOP_K",
    group: "storage",
    type: "number",
    default: "5",
    min: 1,
    max: 20
  },
  {
    name: "KNOWLEDGE_SEARCH_MAX_TOP_K",
    group: "storage",
    type: "number",
    default: "10",
    min: 1,
    max: 50
  },
  {
    name: "KNOWLEDGE_SEARCH_DEFAULT_SCORE_THRESHOLD",
    group: "storage",
    type: "number",
    default: "0.2",
    min: -1,
    max: 1
  },
  {
    name: "KNOWLEDGE_RETRIEVAL_DEBUG_LOGGING",
    group: "storage",
    type: "boolean",
    default: "false"
  },
  // ------------------------------------------------------------------ Queue
  {
    name: "QUEUE_PROVIDER",
    group: "queue",
    type: "string",
    default: "postgres",
    oneOf: ["postgres", "redis"]
  },
  { name: "REDIS_URL", group: "queue", type: "string", default: "" },
  { name: "QUEUE_PREFIX", group: "queue", type: "string", default: "ai-workforce-os" },
  { name: "WORKER_CONCURRENCY", group: "queue", type: "number", default: "4", min: 1, max: 64 },
  { name: "QUEUE_VISIBILITY_MS", group: "queue", type: "number", default: "60000", min: 1000 },
  // ------------------------------------------------------------------ Email
  { name: "SMTP_HOST", group: "email", type: "string", default: "" },
  { name: "SMTP_PORT", group: "email", type: "number", default: "587", min: 1, max: 65_535 },
  { name: "SMTP_USER", group: "email", type: "string", default: "" },
  { name: "SMTP_PASSWORD", group: "email", type: "string", default: "", secret: true },
  { name: "SMTP_FROM", group: "email", type: "string", default: "" },
  { name: "SMTP_FROM_EMAIL", group: "email", type: "string", default: "" },
  { name: "SMTP_FROM_NAME", group: "email", type: "string", default: "" },
  // ------------------------------------------------------------------ Meta WhatsApp
  { name: "META_APP_ID", group: "meta", type: "string", default: "" },
  { name: "META_APP_SECRET", group: "meta", type: "string", default: "", secret: true },
  { name: "META_WEBHOOK_VERIFY_TOKEN", group: "meta", type: "string", default: "", secret: true },
  { name: "META_ACCESS_TOKEN", group: "meta", type: "string", default: "", secret: true },
  // ------------------------------------------------------------------ Observability
  { name: "OTEL_ENABLED", group: "observability", type: "boolean", default: "false" },
  { name: "OTEL_EXPORTER_OTLP_ENDPOINT", group: "observability", type: "url", default: "" },
  {
    name: "LOG_LEVEL",
    group: "observability",
    type: "string",
    default: "info",
    oneOf: ["debug", "info", "warn", "error"]
  },
  {
    name: "TRACE_SAMPLE_RATE",
    group: "observability",
    type: "number",
    default: "1",
    min: 0,
    max: 1
  },
  // ------------------------------------------------------------------ Billing
  { name: "BILLING_ENFORCEMENT_ENABLED", group: "billing", type: "boolean", default: "true" },
  { name: "DEFAULT_PLAN_CODE", group: "billing", type: "string", default: "GROWTH" },
  {
    name: "CREDIT_GRACE_PERCENT",
    group: "billing",
    type: "number",
    default: "0",
    min: 0,
    max: 200
  },
  // ------------------------------------------------------------------ Secrets
  { name: "ALLOW_DEVELOPMENT_IMPLEMENTATIONS", group: "secrets", type: "boolean", default: "true" },
  { name: "ALLOW_LOCALHOST_PRODUCTION", group: "secrets", type: "boolean", default: "false" },
  { name: "PUBLIC_SIGNUP_ENABLED", group: "secrets", type: "boolean", default: "true" }
];

export interface ResolvedConfig {
  fields: Record<
    string,
    { group: EnvGroup; value: string | number | boolean | null; secret: boolean }
  >;
  /** True when every required-in-production variable was present and valid. */
  productionValid: boolean;
}

const FIELD_INDEX = new Map(DEFAULT_FIELDS.map((field) => [field.name, field]));

/** Returns a masked view of a secret value for diagnostics — never the full secret. */
export function maskSecret(value: string, mask: "full" | "tail" | "none" = "tail"): string {
  if (mask === "none") return value;
  if (mask === "full" || value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/**
 * Validates the environment against the schema. Missing optional variables fall back to defaults; missing
 * required-in-production variables collect an issue. Returns the resolved config. Does not throw for
 * optional-group gaps so development keeps working with a minimal .env — but the AppConfig loader calls
 * `assertProductionValid` in production.
 */
export function validateEnvironment(
  environment: Env,
  { productionLike }: { productionLike: boolean }
): ResolvedConfig {
  const issues: string[] = [];
  const fields: ResolvedConfig["fields"] = {};

  for (const field of DEFAULT_FIELDS) {
    const raw = environment[field.name]?.trim();
    const isRequiredHere = field.requiredIn?.includes("production") && productionLike;
    const value = raw ?? field.default;

    if (!value) {
      if (isRequiredHere)
        issues.push(
          `${field.name} is required in ${productionLike ? "production" : "this"} environment`
        );
      fields[field.name] = { group: field.group, value: null, secret: Boolean(field.secret) };
      continue;
    }

    try {
      let parsed: string | number | boolean;
      if (field.type === "number") parsed = parseNumber(value, field);
      else if (field.type === "boolean") parsed = parseBoolean(value);
      else if (field.type === "url") {
        const url = new URL(value);
        // No localhost exemption: a real deployment must never have a plain-HTTP/localhost URL in
        // production/staging, and a local verification stack (e.g. docker-compose.production-like.yml)
        // that can't have a real TLS cert should identify as a non-production APP_ENV instead of trying
        // to carve out an exception here — see security-config.ts's matching (and, before Sprint 5.0B,
        // independently-enforced) rule for WEB_APP_URL/API_PUBLIC_URL.
        if (productionLike && url.protocol !== "https:") {
          throw new Error(`${field.name} must use https in production`);
        }
        parsed = url.toString();
      } else parsed = value;

      if (field.oneOf && !field.oneOf.includes(String(parsed))) {
        throw new Error(`${field.name} must be one of ${field.oneOf.join(", ")}`);
      }
      if (field.pattern && !field.pattern.test(String(parsed))) {
        throw new Error(`${field.name} does not match the required pattern`);
      }
      if (
        field.type === "string" &&
        field.secret &&
        typeof parsed === "string" &&
        parsed.length < 8
      ) {
        throw new Error(`${field.name} is too short`);
      }
      fields[field.name] = { group: field.group, value: parsed, secret: Boolean(field.secret) };
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${field.name} is invalid`);
      fields[field.name] = { group: field.group, value: null, secret: Boolean(field.secret) };
    }
  }

  // Cross-field: STORAGE_PROVIDER=s3 requires S3_BUCKET.
  const provider = fields.STORAGE_PROVIDER?.value;
  if (provider === "s3" && !fields.S3_BUCKET?.value)
    issues.push("S3_BUCKET is required when STORAGE_PROVIDER=s3");
  // Cross-field: QUEUE_PROVIDER=redis requires REDIS_URL.
  const queueProvider = fields.QUEUE_PROVIDER?.value;
  if (queueProvider === "redis" && !fields.REDIS_URL?.value)
    issues.push("REDIS_URL is required when QUEUE_PROVIDER=redis");

  return { fields, productionValid: issues.length === 0 };
}

/** Fails fast in production when validation found issues. */
export function assertProductionValid(config: ResolvedConfig): void {
  if (!config.productionValid) {
    throw new ConfigValidationError(
      Object.values(config.fields)
        .filter((field) => field.value === null)
        .map((field) => {
          const spec = FIELD_INDEX.get(
            Object.entries(config.fields).find(([, f]) => f === field)?.[0] ?? ""
          );
          return `${spec?.name ?? "unknown"} (${spec?.group ?? "unknown"})${spec?.secret ? " [secret]" : ""}`;
        })
    );
  }
}

/** Convenience: true when the resolved environment is production or staging. */
export function isProductionLike(environment: Env): boolean {
  const env = environment.APP_ENV ?? environment.NODE_ENV ?? "development";
  return env === "production" || env === "staging";
}
