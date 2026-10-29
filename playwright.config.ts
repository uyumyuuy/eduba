import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  testMatch: "**/*.pw.ts",
  workers: 1,
  timeout: 120000,
  use: {
    baseURL: "http://127.0.0.1:1421",
    locale: "en-US",
    // Override for a different installed browser or a Playwright browser download.
    channel: process.env.EDUBA_TEST_BROWSER ?? "msedge",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview:web",
    url: "http://127.0.0.1:1421",
    reuseExistingServer: !process.env.CI,
  },
});
