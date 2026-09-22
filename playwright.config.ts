import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { headless: true, viewport: { width: 1440, height: 1000 } },
  reporter: "list",
});
