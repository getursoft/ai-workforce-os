import { InvalidSecurityConfigurationError } from "../../application/errors/security.error";

export const SECURITY_CONFIG = Symbol("SecurityConfig");

export type NodeEnvironment = "development" | "test" | "production";

export interface SecurityConfig {
  nodeEnvironment: NodeEnvironment;
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

function secret(environment: Environment, variable: string): string {
  const value = required(environment, variable);
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new InvalidSecurityConfigurationError(variable);
  }
  return value;
}

function nodeEnvironment(environment: Environment): NodeEnvironment {
  const value = required(environment, "NODE_ENV");
  if (value !== "development" && value !== "test" && value !== "production") {
    throw new InvalidSecurityConfigurationError("NODE_ENV");
  }
  return value;
}

export function loadSecurityConfig(environment: Environment): SecurityConfig {
  return {
    nodeEnvironment: nodeEnvironment(environment),
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
    }
  };
}
