import { defineConfig, devices } from "@playwright/test";

const __dirname = process.cwd();

export default defineConfig({
  testDir: "./tests/uat",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["list"]
  ],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on",
    screenshot: "on",
    video: "on",
    actionTimeout: 15000,
    navigationTimeout: 30000
  },
  projects: [
    {
      name: "recruitment-visual-uat",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        headless: false,
        slowMo: 500,
        launchOptions: {
          args: ["--start-maximized"]
        }
      }
    },
    {
      name: "recruitment-diagnostic",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        headless: true,
        slowMo: 0,
        retries: 2
      }
    }
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    cwd: __dirname
  },
  outputDir: "test-results/artifacts",
  snapshotDir: "test-results/snapshots"
});