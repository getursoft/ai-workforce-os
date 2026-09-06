import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/** Minimal `KEY="value"` / `KEY=value` line parser — avoids adding `dotenv` as a direct dependency
 *  of this config file just to read `.env.test`, matching the format Node's own `loadEnvFile` (used
 *  by every e2e spec in this codebase) already expects. */
function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Vite auto-loads `.env` files as part of its own config-resolution bootstrap, before this file's
 * exported options are even applied, and that bootstrap pass resolves the MONOREPO ROOT's `.env`
 * regardless of this file's `root`/`envDir` settings (confirmed empirically: neither `envDir: false`
 * nor an explicit `root: __dirname` stopped it — a `process.env` setter trap showed the value is
 * already present before this package's own module code, and even before vitest's `setupFiles`,
 * ever run). The root `.env` legitimately holds production values (WEB_APP_URL=https://krevia.in,
 * set for the Cloudflare Tunnel work), which then silently override every e2e spec's own explicit
 * `loadEnvFile(".env.test")` call for any key also present in the root `.env` (dotenv/Node env
 * loading never overrides an already-set value, so whichever loads first wins — the automatic root
 * `.env` pass always runs before each spec file's own top-level code).
 *
 * `test.env` is vitest's own test-phase env override — applied after all of the above, so it
 * reliably wins. Reading `.env.test` here (rather than duplicating its values) keeps ".env.test is
 * the single source of truth for test environment" intact; this config only makes sure that source
 * actually takes effect instead of being silently shadowed by the repo-root `.env`.
 */
const envTestPath = resolve(__dirname, "../../.env.test");
const testEnv = existsSync(envTestPath) ? parseEnvFile(readFileSync(envTestPath, "utf8")) : {};

/**
 * Sprint 7 (voice) discovery: the same "whichever loads first wins" hazard described above applies to
 * apps/api/.env too — @nestjs/config's ConfigModule.forRoot() (called inside every e2e spec's own
 * NestFactory.create(AppModule)) reads real local-dev credentials (Twilio, SMTP) straight off disk from
 * apps/api/.env's CWD-relative default. Those credentials are legitimate for local manual testing against
 * the real providers, but they silently hijack e2e specs that compute Twilio webhook signatures — or
 * expect fast/no-op email delivery — against the DB-stored *test* fixtures those specs actually set up,
 * causing 401s and real multi-second SMTP round-trips (test timeouts) unrelated to whatever the spec is
 * actually asserting. Neutralizing them here (not in .env.test, which stays "unset" = intentionally
 * absent) makes every e2e spec deterministic regardless of what a developer's local apps/api/.env holds.
 */
const externalProviderOverrides = {
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_WHATSAPP_FROM: "",
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASSWORD: ""
};

export default defineConfig({
  test: {
    env: { ...testEnv, ...externalProviderOverrides }
  }
});
