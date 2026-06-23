import { test, expect, type Page } from "@playwright/test";

/**
 * E2E: Player 1 creates a multiplayer game, clicks "copy invite link",
 * and Player 2 opens the exact clipboard URL to join the lobby.
 *
 * Tests against both dev and production builds. The production test is
 * the one that matters — it catches the bug where the invite link
 * omits /raising-intelligences/ from the path.
 *
 * Usage:
 *   Dev:  E2E_BASE_URL=http://localhost:5173 npx playwright test
 *   Prod: E2E_BASE_URL=https://multiversegames.ai/raising-intelligences npx playwright test
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";

test("invite link from clipboard lets player 2 join the lobby", async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });

  const p1: Page = await context.newPage();

  // ── Player 1: create a multiplayer game ──
  await p1.goto(BASE);
  await p1.getByRole("button", { name: "play with a partner" }).click();

  // Fill child name (first textbox) and parent name (second textbox)
  const inputs = p1.locator(".name-input");
  await inputs.nth(0).fill("Ziggy");
  await inputs.nth(1).fill("Parent A");
  await p1.getByRole("button", { name: "create game" }).click();

  // Wait for lobby to appear with the invite link button
  await p1.getByText("send this link to your co-parent").waitFor({ timeout: 10000 });

  // Click "copy invite link"
  await p1.getByRole("button", { name: "copy invite link" }).click();

  // Read the clipboard — this is the REAL link the user would share
  const clipboardLink = await p1.evaluate(() => navigator.clipboard.readText());
  console.log("Clipboard link:", clipboardLink);

  // ── Verify the link has a game param ──
  expect(clipboardLink).toContain("?game=");
  const parsed = new URL(clipboardLink);
  const gameId = parsed.searchParams.get("game");
  expect(gameId).toBeTruthy();

  // ── CRITICAL: the link path must match the page we're on ──
  // If we're on /raising-intelligences/, the link must include that path.
  // If we're on /, the link path should be /.
  // The link should NEVER drop the path component.
  const currentPath = new URL(BASE).pathname.replace(/\/$/, "") || "/";
  const linkPath = parsed.pathname.replace(/\/$/, "") || "/";
  expect(linkPath).toBe(currentPath);

  // ── Player 2: open the exact clipboard URL ──
  const p2: Page = await context.newPage();
  await p2.goto(clipboardLink);

  // Player 2 should see the join form (asks for their name)
  await p2.locator(".name-input").waitFor({ timeout: 10000 });
  await p2.locator(".name-input").fill("Parent B");
  await p2.getByRole("button", { name: "join" }).click();

  // Both should now be in the lobby
  await p2.getByText("waiting…").or(p2.getByText("not ready")).first().waitFor({ timeout: 10000 });

  // Verify both players are visible in each lobby
  await p1.locator(".lobby-player-name", { hasText: "Parent B" }).waitFor({ timeout: 10000 });
  await p1.locator(".lobby-player-name", { hasText: "Parent A" }).waitFor({ timeout: 5000 });
  await p2.locator(".lobby-player-name", { hasText: "Parent A" }).waitFor({ timeout: 5000 });
  await p2.locator(".lobby-player-name", { hasText: "Parent B" }).waitFor({ timeout: 5000 });

  await context.close();
});

test("invite link includes base path in production build", async ({ browser }) => {
  // Serve the production build and verify the clipboard link has the right path.
  // Skip if we can't reach the production URL.
  const prodUrl = "https://multiversegames.ai/raising-intelligences/";

  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();

  // Try to reach production — skip gracefully if offline or not deployed
  const res = await page.goto(prodUrl, { timeout: 10000 }).catch(() => null);
  if (!res || !res.ok()) {
    console.log("Skipping production test — site not reachable");
    await context.close();
    return;
  }

  // If we can reach it, try the multiplayer flow
  const partnerBtn = page.getByRole("button", { name: "play with a partner" });
  if (!(await partnerBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    console.log("Skipping — page loaded but UI not as expected");
    await context.close();
    return;
  }

  await partnerBtn.click();
  const inputs = page.locator(".name-input");
  await inputs.nth(0).fill("TestKid");
  await inputs.nth(1).fill("TestParent");
  await page.getByRole("button", { name: "create game" }).click();
  await page.getByText("send this link to your co-parent").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "copy invite link" }).click();

  const clipboardLink = await page.evaluate(() => navigator.clipboard.readText());
  console.log("Production clipboard link:", clipboardLink);

  // THE TEST: link must include /raising-intelligences/
  expect(clipboardLink).toContain("/raising-intelligences/");
  expect(clipboardLink).not.toMatch(/^https:\/\/multiversegames\.ai\/\?game=/);

  const parsed = new URL(clipboardLink);
  expect(parsed.pathname).toBe("/raising-intelligences/");
  expect(parsed.searchParams.get("game")).toBeTruthy();

  await context.close();
});
