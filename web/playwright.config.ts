import { defineConfig, devices } from "@playwright/test";

/**
 * E2E / smoke config.
 *
 * Targets a deployed (or locally running) MusicLife instance via SMOKE_BASE_URL
 * (defaults to production). These tests are intentionally NOT part of the unit
 * `npm test` (vitest) run — invoke them with `npm run test:e2e` after
 * `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "https://music-life-kappa.vercel.app",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
