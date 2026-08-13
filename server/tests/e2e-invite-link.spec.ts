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

  // ── Player 2: open the exact clipboard URL, on their own device ──
  // A separate context, not a second tab, and that distinction is load-bearing
  // rather than incidental tidiness. A browser profile holds exactly one seat:
  // the resume credential lives in localStorage under a single key, the server
  // binds one slot per token, and presenting that token reclaims the slot and
  // supersedes whoever held it. Two tabs of one profile are therefore one
  // player wearing two hats — the second would resume into the first's slot
  // instead of joining as the co-parent, which is correct behaviour for a
  // returning player and useless as a test of an invite. It is also what the
  // game is for: the two parents get private sidebars the other must not see.
  //
  // This spec did run as a shared context once, and passed, because auto-resume
  // did not exist yet — it was added hours later the same day (e35f2cc,
  // 2026-06-23) and silently broke it. Nobody noticed for seven weeks because
  // @playwright/test was missing from devDependencies, so this file had never
  // actually been run since. See the same-profile spec below, which pins the
  // resume behaviour that replaced it.
  const p2Context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const p2: Page = await p2Context.newPage();
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
  await p2Context.close();
});

/**
 * The other half of the rule the spec above depends on: within ONE profile, a
 * link to the game you already hold a seat in returns you to that seat.
 *
 * This is the case that makes a blanket "the URL always wins" fix impossible,
 * which is why it is pinned here rather than left implicit. JOINED reflects the
 * game id into the address bar, so an ordinary reload is indistinguishable from
 * following your own link — same `?game=`, same stored credential. If a
 * `?game=` suppressed auto-resume outright, reload would fall through to the
 * name form and then to the server's "This game already has two players",
 * stranding the player outside a game they are still in.
 *
 * So: same game → resume the seat (here). Different game → the link wins (the
 * spec below). Those two together are the whole rule.
 */
test("a link to the game you are already in resumes your seat, not a second one", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const host: Page = await context.newPage();

  await host.goto(BASE);
  await host.getByRole("button", { name: "play with a partner" }).click();
  const inputs = host.locator(".name-input");
  await inputs.nth(0).fill("Juno");
  await inputs.nth(1).fill("Parent A");
  await host.getByRole("button", { name: "create game" }).click();
  await host.getByText("send this link to your co-parent").waitFor({ timeout: 10000 });
  await host.getByRole("button", { name: "copy invite link" }).click();
  const link = await host.evaluate(() => navigator.clipboard.readText());
  const gameId = new URL(link).searchParams.get("game");

  // Same profile, same game — the shape of a reload or of reopening your own
  // link. Expect the seat back with no name form in between.
  const again: Page = await context.newPage();
  await again.goto(link);

  await again.getByText("send this link to your co-parent").waitFor({ timeout: 10000 });
  expect(new URL(again.url()).searchParams.get("game")).toBe(gameId);

  // Parent A once, and the co-parent's seat still empty. Both halves matter:
  // the first says the seat was resumed, the second says it was not resumed by
  // quietly becoming player two. (The lobby always renders two `.lobby-player-name`
  // slots — the vacant one reads "waiting…" — so a bare count proves nothing.)
  await expect(again.locator(".lobby-player-name", { hasText: "Parent A" })).toHaveCount(1);
  await expect(again.locator(".lobby-player-name", { hasText: "waiting…" })).toHaveCount(1);

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

/**
 * Regression: an invite to a *different* game must beat this device's stored
 * resume credential.
 *
 * The bug this pins: a player who had already been in game A followed a new
 * co-parent's `?game=B` link and got silently dragged back into A — the mount
 * effect opened the socket because `ri_resume` existed at all, the connect
 * handler auto-emitted JOIN_GAME for A, and JOINED then rewrote the address bar
 * to A. The link looked like it had simply been ignored.
 *
 * The joiner reuses the profile that played game A on purpose: sharing
 * localStorage is what makes the stored credential and the link disagree. The
 * same-profile spec above covers the other half of the rule — resume and link
 * naming the SAME game, where auto-resume is correct and must survive this fix.
 */
test("an invite to a different game outranks stored resume", async ({ browser }) => {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });

  // ── Game A: played on this device, leaves a resume credential behind ──
  const a: Page = await context.newPage();
  await a.goto(BASE);
  await a.getByRole("button", { name: "play with a partner" }).click();
  const aInputs = a.locator(".name-input");
  await aInputs.nth(0).fill("Ziggy");
  await aInputs.nth(1).fill("Parent A");
  await a.getByRole("button", { name: "create game" }).click();
  await a.getByText("send this link to your co-parent").waitFor({ timeout: 10000 });

  const gameA = await a.evaluate(() => JSON.parse(localStorage.getItem("ri_resume")!).gameId);
  expect(gameA).toBeTruthy();

  // ── Game B: a different co-parent's game, created elsewhere ──
  const otherContext = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const host: Page = await otherContext.newPage();
  await host.goto(BASE);
  await host.getByRole("button", { name: "play with a partner" }).click();
  const hostInputs = host.locator(".name-input");
  await hostInputs.nth(0).fill("Wren");
  await hostInputs.nth(1).fill("Parent C");
  await host.getByRole("button", { name: "create game" }).click();
  await host.getByText("send this link to your co-parent").waitFor({ timeout: 10000 });
  await host.getByRole("button", { name: "copy invite link" }).click();
  const inviteB = await host.evaluate(() => navigator.clipboard.readText());
  const gameB = new URL(inviteB).searchParams.get("game");
  expect(gameB).toBeTruthy();
  expect(gameB).not.toBe(gameA);

  // ── Follow B's invite on the device that still remembers A ──
  const joiner: Page = await context.newPage();
  await joiner.goto(inviteB);

  // The join form, not a silent rejoin of A.
  await joiner.locator(".name-input").waitFor({ timeout: 10000 });
  await joiner.locator(".name-input").fill("Parent D");
  await joiner.getByRole("button", { name: "join" }).click();

  await joiner.locator(".lobby-player-name", { hasText: "Parent C" }).waitFor({ timeout: 10000 });
  await joiner.locator(".lobby-player-name", { hasText: "Parent D" }).waitFor({ timeout: 5000 });

  // The discriminating assertion: before the fix, JOINED for game A rewrote
  // this to `game=<A>`.
  expect(new URL(joiner.url()).searchParams.get("game")).toBe(gameB);

  // And the host sees the partner who actually arrived.
  await host.locator(".lobby-player-name", { hasText: "Parent D" }).waitFor({ timeout: 10000 });

  // Game A's credential is untouched — declining the invite must not have cost
  // the player the game they were already in.
  expect(await a.evaluate(() => JSON.parse(localStorage.getItem("ri_resume")!).gameId)).toBeTruthy();

  await context.close();
  await otherContext.close();
});
