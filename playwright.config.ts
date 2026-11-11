import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e",
  timeout: 180000,
  workers: 1,
  fullyParallel: false,
  use: { headless: true },
});
