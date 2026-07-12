import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(resolve(root, ".env.test"));
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const database = new URL(url).pathname.slice(1);
if (!database.endsWith("_test"))
  throw new Error(`Refusing to prepare non-test database: ${database}`);

const prisma = resolve(root, "node_modules/.bin/prisma");
for (const args of [
  ["migrate", "deploy", "--schema=database/prisma/schema.prisma"],
  ["db", "seed", "--schema=database/prisma/schema.prisma"]
]) {
  const result = spawnSync(prisma, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
