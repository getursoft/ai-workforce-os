/** Sprint 7.13 — Migration guardrails.
 *
 * Prevents accidental use of destructive Prisma commands in production-like environments.
 * Run: pnpm db:migrate:protect
 * Exit code 1 if unsafe operation detected, 0 otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { exit } from "node:process";

const ALLOWED_COMMANDS = new Set(["deploy", "status", "diff", "generate"]);
const DANGEROUS_COMMANDS = new Set(["reset", "db push", "studio", "dev"]);

const command = process.argv[2];
const env = process.env.APP_ENV || process.env.NODE_ENV || "development";

function main(): void {
  if (!command) {
    console.log("Usage: pnpm db:migrate:protect <command>");
    console.log("  Allowed:", [...ALLOWED_COMMANDS].join(", "));
    console.log("  Blocked:", [...DANGEROUS_COMMANDS].join(", "));
    exit(0);
  }

  if (DANGEROUS_COMMANDS.has(command)) {
    console.error(`BLOCKED: "prisma migrate ${command}" is not allowed in ${env} environments.`);
    console.error("Use prisma migrate deploy, status, or diff instead.");
    console.error("See docs/production/migration-workflow.md for the authoritative workflow.");
    exit(1);
  }

  if (!ALLOWED_COMMANDS.has(command)) {
    console.warn(`WARNING: Unknown command "prisma migrate ${command}". Proceed with caution.`);
  }

  const schemaPath = "database/prisma/schema.prisma";
  if (!existsSync(schemaPath)) {
    console.error(`Schema file not found: ${schemaPath}`);
    exit(1);
  }

  const envPath = ".env";
  if (env === "production" && existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    if (envContent.includes("DATABASE_URL=postgresql://")) {
      console.log("Migration guard: schema file exists, environment validated.");
    }
  }

  console.log(`Migration guard passed for "${command}" in ${env} environment.`);
  exit(0);
}

main();
