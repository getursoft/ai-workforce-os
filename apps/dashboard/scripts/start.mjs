import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// `next build` (output: "standalone") produces a self-contained server at
// .next/standalone/apps/dashboard/server.js, but does not copy the static assets or public/
// folder into it (see https://nextjs.org/docs/app/api-reference/config/next-config-js/output).
// Dockerfile.dashboard does this copy step manually at image-build time; this mirrors that for a
// bare `pnpm start` on a host without Docker.
const root = process.cwd();
const standaloneAppDir = resolve(root, ".next/standalone/apps/dashboard");
const serverEntry = resolve(standaloneAppDir, "server.js");

if (!existsSync(serverEntry)) {
  console.error(`Standalone server not found at ${serverEntry}. Run "pnpm build" first.`);
  process.exit(1);
}

cpSync(resolve(root, ".next/static"), resolve(standaloneAppDir, ".next/static"), { recursive: true });
if (existsSync(resolve(root, "public"))) {
  cpSync(resolve(root, "public"), resolve(standaloneAppDir, "public"), { recursive: true });
}

const result = spawnSync(process.execPath, [serverEntry], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0",
    PORT: process.env.PORT ?? "3000"
  }
});

process.exit(result.status ?? 1);
