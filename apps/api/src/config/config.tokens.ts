import type { SecurityConfig } from "../identity/infrastructure/security/security-config";

export const APP_CONFIG = Symbol("AppConfig");

export type ProcessRole = "all" | "api" | "scheduler" | "workforce-worker" | "channel-worker" | "maintenance";

/** The shape consumed by any service that needs typed config (kept separate from the class to avoid
 *  circular type imports). */
export interface AppConfig {
  readonly security: SecurityConfig;
  readonly productionLike: boolean;
  readonly processRole: ProcessRole;
  runs(role: Exclude<ProcessRole, "all">): boolean;
  get(name: string): string | number | boolean | null;
  string(name: string, fallback?: string): string;
  number(name: string, fallback?: number): number;
  boolean(name: string, fallback?: boolean): boolean;
  startupSummary(): string;
}
