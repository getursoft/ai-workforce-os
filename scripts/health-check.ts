import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

type PackageManifest = {
  packageManager?: string;
  engines?: {
    node?: string;
    pnpm?: string;
  };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type WorkspaceManifest = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const root = process.cwd();

const requiredFolders = [
  "apps/dashboard",
  "apps/api",
  "packages/kernel",
  "packages/domain",
  "packages/plugin-sdk",
  "packages/shared",
  "plugins/dummy",
  "database",
  "docs",
  "tests",
  "scripts"
];

const requiredRootFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "eslint.config.mjs",
  ".prettierrc.json",
  "docker-compose.yml",
  "database/prisma/schema.prisma",
  ".env.example"
];

const workspacePackages = [
  "apps/dashboard",
  "apps/api",
  "packages/kernel",
  "packages/domain",
  "packages/plugin-sdk",
  "packages/shared",
  "plugins/dummy"
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

const packageManifest = readJson<PackageManifest>("package.json");
const checks: Check[] = [];

for (const folder of requiredFolders) {
  checks.push(check(`folder:${folder}`, existsSync(join(root, folder)), folder));
}

for (const file of requiredRootFiles) {
  checks.push(check(`file:${file}`, existsSync(join(root, file)), file));
}

const rootScripts = ["dev", "build", "lint", "test", "clean", "format", "typecheck", "check"];
for (const script of rootScripts) {
  checks.push(
    check(
      `root-script:${script}`,
      Boolean(packageManifest.scripts?.[script]),
      packageManifest.scripts?.[script] ?? "missing"
    )
  );
}

checks.push(
  check(
    "node-version",
    Boolean(packageManifest.engines?.node),
    packageManifest.engines?.node ?? "missing"
  )
);
checks.push(
  check(
    "pnpm-version",
    Boolean(packageManifest.packageManager && packageManifest.engines?.pnpm),
    `${packageManifest.packageManager ?? "missing"} ${packageManifest.engines?.pnpm ?? "missing"}`
  )
);

for (const workspacePackage of workspacePackages) {
  const packagePath = `${workspacePackage}/package.json`;
  const tsconfigPath = `${workspacePackage}/tsconfig.json`;
  const readmePath = `${workspacePackage}/README.md`;
  const sourcePath = `${workspacePackage}/src`;
  checks.push(
    check(`workspace-package:${packagePath}`, existsSync(join(root, packagePath)), packagePath)
  );
  checks.push(
    check(`workspace-tsconfig:${tsconfigPath}`, existsSync(join(root, tsconfigPath)), tsconfigPath)
  );
  checks.push(
    check(`workspace-readme:${readmePath}`, existsSync(join(root, readmePath)), readmePath)
  );
  checks.push(check(`workspace-src:${sourcePath}`, existsSync(join(root, sourcePath)), sourcePath));

  if (existsSync(join(root, packagePath))) {
    const manifest = readJson<WorkspaceManifest>(packagePath);
    for (const script of ["build", "clean", "lint", "test", "typecheck"]) {
      checks.push(
        check(
          `${workspacePackage}:script:${script}`,
          Boolean(manifest.scripts?.[script]),
          manifest.scripts?.[script] ?? "missing"
        )
      );
    }
  }
}

const envExample = readFileSync(join(root, ".env.example"), "utf8");
checks.push(check("env:DATABASE_URL", envExample.includes("DATABASE_URL="), ".env.example"));

const schema = readFileSync(join(root, "database/prisma/schema.prisma"), "utf8");
checks.push(check("prisma:no-models", !/^\s*model\s+\w+/m.test(schema), "configuration only"));

const failed = checks.filter((item) => !item.passed);

for (const item of checks) {
  const status = item.passed ? "PASS" : "FAIL";
  console.log(`${status} ${item.name} ${item.detail}`);
}

console.log(`SUMMARY ${checks.length - failed.length}/${checks.length} passed`);

if (failed.length > 0) {
  process.exitCode = 1;
}
