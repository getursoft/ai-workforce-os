import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const tsconfigPath = resolve(process.cwd(), "tsconfig.json");
const originalTsconfig = readFileSync(tsconfigPath, "utf8");
let exitCode = 0;

try {
  const result = spawnSync(resolve(process.cwd(), "node_modules/.bin/next"), ["build"], {
    stdio: "inherit"
  });
  exitCode = result.status ?? 1;
} finally {
  writeFileSync(tsconfigPath, originalTsconfig);
}

process.exit(exitCode);
