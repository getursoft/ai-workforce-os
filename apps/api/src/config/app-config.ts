/**
 * Sprint 5.0 — typed application configuration (Phase 2).
 *
 * Composes the strict schema validation (env.schema.ts) with the existing SecurityConfig loader into one
 * injectable AppConfig. Bootstrapping calls `AppConfigFactory.validate()` once, before Nest creates the
 * app, so a production misconfiguration fails fast with a clear list of issues. Secret values are stored
 * in the resolved map but only surfaced through SecretProvider — never logged or returned by APIs.
 */

import { Global, Injectable, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig as AppConfigToken, type ProcessRole } from "./config.tokens";
import {
  assertProductionValid,
  isProductionLike,
  validateEnvironment,
  type ResolvedConfig
} from "./env.schema";
import { loadSecurityConfig, type SecurityConfig } from "../identity/infrastructure/security/security-config";

@Injectable()
export class AppConfig implements AppConfigToken {
  private readonly validated: ResolvedConfig;
  readonly security: SecurityConfig;
  readonly productionLike: boolean;
  readonly processRole: ProcessRole;

  constructor(environment: Readonly<Record<string, string | undefined>>) {
    this.productionLike = isProductionLike(environment);
    this.validated = validateEnvironment(environment, { productionLike: this.productionLike });
    assertProductionValid(this.validated);
    this.security = loadSecurityConfig(environment);
    const role = (this.get("PROCESS_ROLE") as string) || "all";
    this.processRole = (["all", "api", "scheduler", "workforce-worker", "channel-worker", "maintenance"].includes(role)
      ? role
      : "all") as ProcessRole;
  }

  /** Whether this process should run a given worker role (Phase 3). */
  runs(role: Exclude<ProcessRole, "all">): boolean {
    return this.processRole === "all" || this.processRole === role;
  }

  get(name: string): string | number | boolean | null {
    return this.validated.fields[name]?.value ?? null;
  }

  string(name: string, fallback = ""): string {
    const value = this.get(name);
    return value == null ? fallback : String(value);
  }

  number(name: string, fallback = 0): number {
    const value = this.get(name);
    return typeof value === "number" ? value : fallback;
  }

  boolean(name: string, fallback = false): boolean {
    const value = this.get(name);
    return typeof value === "boolean" ? value : fallback;
  }

  /** Masked diagnostic summary — never prints full secrets. */
  startupSummary(): string {
    const groups = new Map<string, number>();
    for (const field of Object.values(this.validated.fields)) {
      groups.set(field.group, (groups.get(field.group) ?? 0) + (field.value === null ? 0 : 1));
    }
    return [...groups.entries()]
      .map(([group, count]) => `${group}:${count}`)
      .join(" ");
  }
}

/** Builds the AppConfig from process.env — used at bootstrap before the module graph exists. */
export function buildAppConfig(environment: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  return new AppConfig(environment);
}

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => buildAppConfig()
    }
  ],
  exports: [APP_CONFIG]
})
export class ConfigModule {}
