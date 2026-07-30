import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "react"
    }
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/marketing/*" mapping — Vite/Vitest does not read
    // tsconfig "paths" on its own, so ported marketing tests/components need this to resolve.
    alias: {
      "@": path.resolve(dirname, "./src/marketing")
    }
  },
  test: {
    environment: "node",
    globals: true,
    // Ported marketing component tests opt into jsdom individually via a
    // "// @vitest-environment jsdom" pragma at the top of the file — every other (dashboard) test keeps
    // running under the faster "node" environment above, unchanged.
    setupFiles: ["./src/marketing/vitest.setup.ts"]
  }
});
