import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const tsconfigPath = resolve(process.cwd(), "tsconfig.json");
const buildOutputPath = resolve(process.cwd(), ".next");
const originalTsconfig = readFileSync(tsconfigPath, "utf8");
const tsconfigForBuild = JSON.parse(originalTsconfig);
if (tsconfigForBuild.compilerOptions && typeof tsconfigForBuild.compilerOptions === "object") {
  tsconfigForBuild.compilerOptions.jsx = "preserve";
}
let exitCode = 0;

try {
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfigForBuild, null, 2)}\n`);
  rmSync(buildOutputPath, { force: true, recursive: true });
  const result = spawnSync(resolve(process.cwd(), "node_modules/.bin/next"), ["build"], {
    stdio: "inherit"
  });
  exitCode = result.status ?? 1;
} finally {
  writeFileSync(tsconfigPath, originalTsconfig);
}

process.exit(exitCode);
