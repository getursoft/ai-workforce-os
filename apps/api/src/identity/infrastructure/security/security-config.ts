import { InvalidSecurityConfigurationError } from "../../application/errors/security.error";

export const SECURITY_CONFIG = Symbol("SecurityConfig");

export type NodeEnvironment = "development" | "test" | "staging" | "production";

export interface SecurityConfig {
  nodeEnvironment: NodeEnvironment;
  databaseUrl: string;
  webAppUrl: string;
  apiPublicUrl: string;
  serverPort: number;
  allowDevelopmentImplementations: boolean;
  /** The single universal platform-owner email (env PLATFORM_OWNER_EMAIL). This account is a
   *  superadmin that can access and administer every organization. */
  platformOwnerEmail: string;
  /** When false, public self-registration is disabled — organizations can only be created by the
   *  platform owner. Defaults to enabled outside production/staging so the test suite can provision
   *  throwaway organizations via /auth/register. */
  publicSignupEnabled: boolean;
  pluginDirectory?: string;
  passwordHash: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  accessToken: {
    secret: string;
    expiresInSeconds: number;
    issuer: string;
    audience: string;
  };
  refreshToken: {
    expiresInSeconds: number;
    pepper: string;
  };
  apiKey: { pepper: string };
  pluginSecrets: {
    encryptionKey: Buffer;
    currentVersion: number;
    /** Sprint 5.0 Phase 7: set only while a key rotation is in progress — lets old ciphertexts (encrypted
     *  under the previous key/version) keep decrypting after PLUGIN_SECRETS_ENCRYPTION_KEY is rotated,
     *  until they're re-encrypted under the new key. */
    previousKey?: Buffer;
    previousVersion?: number;
  };
  knowledge: {
    storagePath: string;
    maxFileSizeBytes: number;
    chunkTargetTokens: number;
    chunkOverlapTokens: number;
    searchCandidateLimit: number;
    searchDefaultTopK: number;
    searchMaxTopK: number;
    searchDefaultScoreThreshold: number;
    retrievalDebugLogging: boolean;
  };
  browserAuth: {
    cookieDomain?: string;
    cookieSecure: boolean;
    cookieSameSite: "lax" | "strict" | "none";
  };
  accountLockout: {
    maxFailedAttempts: number;
    lockoutDurationSeconds: number;
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

const INTEGER = /^\d+$/;

function required(environment: Environment, variable: string): string {
  const value = environment[variable]?.trim();
  if (!value) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return value;
}

function integer(
  environment: Environment,
  variable: string,
  minimum: number,
  maximum: number
): number {
  const raw = required(environment, variable);
  if (!INTEGER.test(raw)) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return value;
}

function float(
  environment: Environment,
  variable: string,
  minimum: number,
  maximum: number
): number {
  const raw = required(environment, variable);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return value;
}

function secret(environment: Environment, variable: string): string {
  const value = required(environment, variable);
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return value;
}

function base64Key(environment: Environment, variable: string): Buffer {
  const raw = required(environment, variable);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return key;
}

/** Sprint 5.0 Phase 7: unlike base64Key, never required — used only for the previous encryption key
 *  during a rotation window, where its absence just means "no rotation in progress." */
function optionalBase64Key(environment: Environment, variable: string): Buffer | undefined {
  const raw = environment[variable]?.trim();
  if (!raw) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return key;
}

function optionalPositiveInt(environment: Environment, variable: string, fallback: number): number {
  const raw = environment[variable]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new InvalidSecurityConfigurationError(variable);
  return parsed;
}

function pluginSecretsConfig(environment: Environment): SecurityConfig["pluginSecrets"] {
  const encryptionKey = base64Key(environment, "PLUGIN_SECRETS_ENCRYPTION_KEY");
  const currentVersion = optionalPositiveInt(environment, "SECRET_KEY_VERSION", 1);
  const previousKey = optionalBase64Key(environment, "PLUGIN_SECRETS_ENCRYPTION_KEY_PREVIOUS");
  if (!previousKey) return { encryptionKey, currentVersion };
  return { encryptionKey, currentVersion, previousKey, previousVersion: optionalPositiveInt(environment, "SECRET_KEY_VERSION_PREVIOUS", 1) };
}

function url(environment: Environment, variable: string): string {
  const value = required(environment, variable);
  try {
    return new URL(value).origin;
  } catch {
    throw new InvalidSecurityConfigurationError(variable);
  }
}

function optionalUrl(environment: Environment, variable: string): string | undefined {
  const value = environment[variable]?.trim();
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    throw new InvalidSecurityConfigurationError(variable);
  }
}

function optionalString(environment: Environment, variable: string): string | undefined {
  const value = environment[variable]?.trim();
  return value ? value : undefined;
}

function boolean(environment: Environment, variable: string, fallback: boolean): boolean {
  const value = environment[variable]?.trim();
  if (!value) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new InvalidSecurityConfigurationError(variable);
}

function nodeEnvironment(environment: Environment): NodeEnvironment {
  const value = (environment.APP_ENV ?? environment.NODE_ENV)?.trim();
  if (!value || !["development", "test", "staging", "production"].includes(value)) {
    throw new InvalidSecurityConfigurationError("APP_ENV");
  }
  return value as NodeEnvironment;
}

export function loadSecurityConfig(environment: Environment): SecurityConfig {
  const node = nodeEnvironment(environment);
  const productionLike = node === "production" || node === "staging";
  const databaseUrl = required(environment, "DATABASE_URL");
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new InvalidSecurityConfigurationError("DATABASE_URL");
  }
  if (!["postgres:", "postgresql:"].includes(database.protocol))
    throw new InvalidSecurityConfigurationError("DATABASE_URL");
  const allowLocalProduction = boolean(environment, "ALLOW_LOCALHOST_PRODUCTION", false);
  if (
    productionLike &&
    !allowLocalProduction &&
    ["localhost", "127.0.0.1", "::1"].includes(database.hostname.toLowerCase())
  )
    throw new InvalidSecurityConfigurationError("DATABASE_URL");
  if (productionLike && /(?:^|_)test(?:$|_)/i.test(database.pathname.slice(1)))
    throw new InvalidSecurityConfigurationError("DATABASE_URL");
  const cookieSecure = boolean(environment, "COOKIE_SECURE", node === "production");
  const cookieSameSite = optionalString(environment, "COOKIE_SAME_SITE") ?? "lax";
  if (cookieSameSite !== "lax" && cookieSameSite !== "strict" && cookieSameSite !== "none") {
    throw new InvalidSecurityConfigurationError("COOKIE_SAME_SITE");
  }
  if (cookieSameSite === "none" && !cookieSecure) {
    throw new InvalidSecurityConfigurationError("COOKIE_SAME_SITE");
  }
  if (productionLike && !cookieSecure) throw new InvalidSecurityConfigurationError("COOKIE_SECURE");
  const webAppUrl = url(environment, "WEB_APP_URL");
  if (productionLike && !webAppUrl.startsWith("https://"))
    throw new InvalidSecurityConfigurationError("WEB_APP_URL");
  const serverPort = integer(
    { ...environment, PORT: environment.PORT ?? "4000" },
    "PORT",
    1,
    65_535
  );
  const configuredApiPublicUrl = optionalUrl(environment, "API_PUBLIC_URL");
  if (productionLike && !configuredApiPublicUrl)
    throw new InvalidSecurityConfigurationError("API_PUBLIC_URL");
  if (configuredApiPublicUrl && !configuredApiPublicUrl.startsWith("https://") && productionLike)
    throw new InvalidSecurityConfigurationError("API_PUBLIC_URL");
  const apiPublicUrl = configuredApiPublicUrl ?? `http://localhost:${serverPort}`;
  const allowDevelopmentImplementations = boolean(
    environment,
    "ALLOW_DEVELOPMENT_IMPLEMENTATIONS",
    !productionLike
  );
  const publicSignupEnabled = boolean(
    environment,
    "PUBLIC_SIGNUP_ENABLED",
    !productionLike
  );
  const platformOwnerEmail = (
    optionalString(environment, "PLATFORM_OWNER_EMAIL") ?? "krpandey25646@gmail.com"
  ).trim().toLowerCase();
  const pluginDirectory = optionalString(environment, "PLUGIN_DIRECTORY");
  if (productionLike && allowDevelopmentImplementations)
    throw new InvalidSecurityConfigurationError("ALLOW_DEVELOPMENT_IMPLEMENTATIONS");
  for (const variable of ["JWT_ACCESS_SECRET", "REFRESH_TOKEN_PEPPER", "API_KEY_PEPPER"] as const) {
    const value = required(environment, variable);
    if (productionLike && /replace|development|test[-_ ]secret|changeme/i.test(value))
      throw new InvalidSecurityConfigurationError(variable);
  }
  const browserAuth: SecurityConfig["browserAuth"] = {
    cookieSecure,
    cookieSameSite
  };
  const cookieDomain = optionalString(environment, "COOKIE_DOMAIN");
  if (cookieDomain) {
    browserAuth.cookieDomain = cookieDomain;
  }
  return {
    nodeEnvironment: node,
    databaseUrl,
    webAppUrl,
    apiPublicUrl,
    serverPort,
    allowDevelopmentImplementations,
    platformOwnerEmail,
    publicSignupEnabled,
    ...(pluginDirectory ? { pluginDirectory } : {}),
    passwordHash: {
      memoryCost: integer(environment, "PASSWORD_HASH_MEMORY_COST", 8192, 1_048_576),
      timeCost: integer(environment, "PASSWORD_HASH_TIME_COST", 1, 10),
      parallelism: integer(environment, "PASSWORD_HASH_PARALLELISM", 1, 16)
    },
    accessToken: {
      secret: secret(environment, "JWT_ACCESS_SECRET"),
      expiresInSeconds: integer(environment, "JWT_ACCESS_EXPIRES_IN_SECONDS", 1, 86_400),
      issuer: required(environment, "JWT_ACCESS_ISSUER"),
      audience: required(environment, "JWT_ACCESS_AUDIENCE")
    },
    refreshToken: {
      expiresInSeconds: integer(environment, "REFRESH_TOKEN_EXPIRES_IN_SECONDS", 1, 31_536_000),
      pepper: secret(environment, "REFRESH_TOKEN_PEPPER")
    },
    apiKey: { pepper: secret(environment, "API_KEY_PEPPER") },
    pluginSecrets: pluginSecretsConfig(environment),
    knowledge: {
      storagePath: optionalString(environment, "KNOWLEDGE_STORAGE_PATH") ?? "./storage/knowledge",
      maxFileSizeBytes:
        integer(
          {
            ...environment,
            KNOWLEDGE_MAX_FILE_SIZE_MB: environment.KNOWLEDGE_MAX_FILE_SIZE_MB ?? "10"
          },
          "KNOWLEDGE_MAX_FILE_SIZE_MB",
          1,
          50
        ) *
        1024 *
        1024,
      chunkTargetTokens: integer(
        {
          ...environment,
          KNOWLEDGE_CHUNK_TARGET_TOKENS: environment.KNOWLEDGE_CHUNK_TARGET_TOKENS ?? "500"
        },
        "KNOWLEDGE_CHUNK_TARGET_TOKENS",
        400,
        600
      ),
      chunkOverlapTokens: integer(
        {
          ...environment,
          KNOWLEDGE_CHUNK_OVERLAP_TOKENS: environment.KNOWLEDGE_CHUNK_OVERLAP_TOKENS ?? "100"
        },
        "KNOWLEDGE_CHUNK_OVERLAP_TOKENS",
        80,
        120
      ),
      searchCandidateLimit: integer(
        {
          ...environment,
          KNOWLEDGE_SEARCH_CANDIDATE_LIMIT: environment.KNOWLEDGE_SEARCH_CANDIDATE_LIMIT ?? "1000"
        },
        "KNOWLEDGE_SEARCH_CANDIDATE_LIMIT",
        10,
        5000
      ),
      searchDefaultTopK: integer(
        {
          ...environment,
          KNOWLEDGE_SEARCH_DEFAULT_TOP_K: environment.KNOWLEDGE_SEARCH_DEFAULT_TOP_K ?? "5"
        },
        "KNOWLEDGE_SEARCH_DEFAULT_TOP_K",
        1,
        20
      ),
      searchMaxTopK: integer(
        {
          ...environment,
          KNOWLEDGE_SEARCH_MAX_TOP_K: environment.KNOWLEDGE_SEARCH_MAX_TOP_K ?? "10"
        },
        "KNOWLEDGE_SEARCH_MAX_TOP_K",
        1,
        50
      ),
      searchDefaultScoreThreshold: float(
        {
          ...environment,
          KNOWLEDGE_SEARCH_DEFAULT_SCORE_THRESHOLD:
            environment.KNOWLEDGE_SEARCH_DEFAULT_SCORE_THRESHOLD ?? "0.2"
        },
        "KNOWLEDGE_SEARCH_DEFAULT_SCORE_THRESHOLD",
        -1,
        1
      ),
      retrievalDebugLogging: boolean(environment, "KNOWLEDGE_RETRIEVAL_DEBUG_LOGGING", false)
    },
    browserAuth,
    accountLockout: {
      maxFailedAttempts: integer(
        { ...environment, ACCOUNT_LOCKOUT_MAX_ATTEMPTS: environment.ACCOUNT_LOCKOUT_MAX_ATTEMPTS ?? "5" },
        "ACCOUNT_LOCKOUT_MAX_ATTEMPTS",
        1,
        20
      ),
      lockoutDurationSeconds: integer(
        {
          ...environment,
          ACCOUNT_LOCKOUT_DURATION_SECONDS: environment.ACCOUNT_LOCKOUT_DURATION_SECONDS ?? "900"
        },
        "ACCOUNT_LOCKOUT_DURATION_SECONDS",
        1,
        86_400
      )
    }
  };
}
