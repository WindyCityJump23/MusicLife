import { expect, test } from "@playwright/test";

/**
 * Deployment smoke tests. These run against a live URL (SMOKE_BASE_URL) and
 * verify the unauthenticated surfaces and health endpoints respond — no
 * Spotify credentials required. Run with `npm run test:e2e`.
 */

test("landing page renders the connect CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "MusicLife" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Connect with Spotify/i })).toBeVisible();
  // The playlist-import alternative path is offered too.
  await expect(page.getByText(/How it works/i)).toBeVisible();
});

test("unauthenticated /dashboard redirects home (middleware)", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/$/);
});

test("protected API routes reject anonymous callers", async ({ request }) => {
  const res = await request.get("/api/readiness");
  expect(res.status()).toBe(401);
});
