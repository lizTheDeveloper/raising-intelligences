#!/usr/bin/env node
/**
 * Comprehensive Playtest Script for "Raising Intelligences"
 *
 * Tests the full solo game flow: start → guardian → event intro → chat →
 * processing → debrief → second event → chat → end chat → debrief →
 * epilogue → report card. Also tests edge cases: empty input, disabled
 * buttons, error banners, console errors, etc.
 *
 * Usage:
 *   node playtest-full.js [BASE_URL]
 *   HEADLESS=0 node playtest-full.js  # show browser
 */

// @ts-check
const { chromium } = require("playwright");

const BASE_URL = process.argv[2] || "http://localhost:5173";
const CHILD_NAME = "Aria";
const LLM_TIMEOUT_MS = 120_000;
const HEADLESS = process.env.HEADLESS !== "0";

const issues = [];

function logIssue(title, body, labels = ["playtest"]) {
  issues.push({ title, body, labels });
  console.log(`[ISSUE] ${title}: ${body.slice(0, 80)}...`);
}

async function run() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console errors and network failures
  const consoleErrors = [];
  const networkErrors = [];
  const uncaughtErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    uncaughtErrors.push(err.message);
  });

  page.on("requestfailed", (req) => {
    networkErrors.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText,
    });
  });

  try {
    console.log(`[playtest] → ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20_000 });

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 1: START SCREEN (mode picker)
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[phase 1] start screen (mode picker)");

    // Wait for mode picker to appear
    await page.waitForSelector(".mode-choice", { timeout: 10_000 });
    console.log("  ✓ mode choice screen visible");

    // Verify title
    const title = await page.$eval("h1", (el) => el.textContent);
    if (title.trim() !== "raising intelligences") {
      logIssue(
        "Start screen title text mismatch",
        `Expected 'raising intelligences' but got '${title.trim()}'`
      );
    }

    // Verify tagline exists
    const tagline = await page.$eval(".start-screen .dim", (el) => el.textContent);
    if (!tagline || tagline.trim().length === 0) {
      logIssue(
        "Missing tagline on start screen",
        "The start screen should show a tagline (dim text below title)."
      );
    } else {
      console.log(`  ✓ tagline: "${tagline.trim()}"`);
    }

    // Verify both mode buttons exist
    const soloBtn = await page.$(".mode-choice .btn-secondary");
    const multiBtn = await page.$(".mode-choice .btn");
    if (!soloBtn || !multiBtn) {
      logIssue(
        "Missing mode buttons",
        `solo: ${!!soloBtn}, multiplayer: ${!!multiBtn}`
      );
    }

    // Click "play solo"
    await page.click(".mode-choice .btn-secondary");
    console.log("  ✓ clicked 'play solo'");

    // Wait for solo game screen with name input
    await page.waitForSelector(".start-screen input.name-input", { timeout: 10_000 });
    console.log("  ✓ solo game name screen visible");

    // Test: "begin" button should be disabled with empty input
    const beginBtnDisabled = await page.$eval('[data-testid="btn-begin"]', (el) =>
      el.disabled
    );
    if (!beginBtnDisabled) {
      logIssue(
        "Begin button enabled with empty name",
        "The 'begin' button on the start screen is clickable even when the name input is empty. It should be disabled."
      );
    } else {
      console.log("  ✓ begin button correctly disabled with empty input");
    }

    // Test: Try submitting empty form via Enter key
    const nameInput = await page.$("input.name-input");
    await nameInput.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    // Check we're still on start screen (shouldn't have navigated)
    const stillOnStart = await page.$('[data-testid="btn-begin"]');
    if (!stillOnStart) {
      logIssue(
        "Empty name creates game",
        "Pressing Enter on empty name input created/navigated to a new game screen. Should have been blocked."
      );
    }

    // Test: Submit with spaces only
    await page.fill("input.name-input", "   ");
    const beginBtnAfterSpaces = await page.$eval('[data-testid="btn-begin"]', (el) => ({
      disabled: el.disabled,
      text: el.textContent,
    }));
    if (!beginBtnAfterSpaces.disabled) {
      logIssue(
        "Begin button enabled with whitespace-only name",
        "The 'begin' button is enabled when only spaces are entered. The trim() check in handleStart prevents game creation, but the button should still appear disabled for clear UX."
      );
    }

    // Fill in a real name
    await page.fill("input.name-input", CHILD_NAME);
    console.log(`  ✓ entered child name: ${CHILD_NAME}`);

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 2: CREATE GAME + GUARDIAN SCREEN
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[phase 2] creating game and guardian screen");
    await page.click('[data-testid="btn-begin"]');

    // Wait for guardian screen to appear
    await page.waitForSelector(".guardian-screen", { timeout: 30_000 });
    console.log("  ✓ guardian screen visible");

    // Test: Guardian screen shows child name
    const guardianName = await page.$eval(".guardian-name", (el) => el.textContent);
    if (guardianName !== CHILD_NAME) {
      logIssue(
        "Guardian screen shows wrong child name",
        `Expected '${CHILD_NAME}' but got '${guardianName}'`
      );
    } else {
      console.log(`  ✓ guardian screen shows child name: ${guardianName}`);
    }

    // Wait for "I'm ready" button (this means intro animation + event loaded)
    console.log("  waiting for guardian ready button (animation + LLM)...");
    await page.waitForSelector('[data-testid="btn-guardian-ready"]', {
      timeout: LLM_TIMEOUT_MS,
    });
    console.log("  ✓ guardian ready button appeared");

    // Test: Click "I'm not ready" and verify behavior
    await page.click('[data-testid="btn-guardian-not-ready"]');
    await page.waitForTimeout(200);

    // After clicking "not ready", buttons should disappear
    const buttonsAfterNotReady = await page.$('[data-testid="btn-guardian-ready"]');
    if (buttonsAfterNotReady) {
      logIssue(
        "Guardian buttons remain after 'not ready' click",
        "After clicking 'I'm not ready', the 'I'm ready' button should disappear but it's still visible."
      );
    }

    // Check "most people aren't" message appears
    await page.waitForSelector(".guardian-not-ready-message", { timeout: 3000 });
    console.log("  ✓ 'most people aren't' message shown after 'not ready'");

    // Wait for the 1.5s timeout to dismiss guardian screen
    await page.waitForTimeout(2000);

    // Should now be past guardian screen - either at event_intro
    const guardianStillVisible = await page.$(".guardian-screen");
    if (guardianStillVisible) {
      console.log("  ⏳ guardian screen still visible (waiting for dismissal)");
      await page.waitForSelector(".guardian-screen", { state: "detached", timeout: 5000 });
    }
    console.log("  ✓ guardian screen dismissed");

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 3: FIRST EVENT INTRO
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[phase 3] first event intro");

    // Wait for event intro
    await page.waitForSelector(".event-intro", { timeout: LLM_TIMEOUT_MS });

    // Check if event is loading or loaded
    const eventLoading = await page.$(".event-loading");
    if (eventLoading) {
      console.log("  event is loading, waiting for event data...");
      // Wait for loading to complete and event to show
      await page.waitForSelector('[data-testid="btn-enter-event"]', {
        timeout: LLM_TIMEOUT_MS,
      });
    } else {
      // Event might already be loaded
      const enterBtn = await page.$('[data-testid="btn-enter-event"]');
      if (enterBtn) {
        console.log("  ✓ event already loaded");
      } else {
        console.log("  waiting for event to load...");
        await page.waitForSelector('[data-testid="btn-enter-event"]', {
          timeout: LLM_TIMEOUT_MS,
        });
      }
    }

    // Test: Check event content exists
    const eventDescription = await page.$eval(
      ".event-description",
      (el) => el.textContent
    );
    console.log(`  ✓ event description: "${eventDescription?.slice(0, 60)}..."`);

    const ageMarker = await page.$eval(".age-marker", (el) => el.textContent).catch(() => null);
    console.log(`  ✓ age marker: ${ageMarker}`);

    // Click enter to start chat
    await page.click('[data-testid="btn-enter-event"]');
    console.log("  ✓ entered event");

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 4: FIRST FAMILY CHAT
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[phase 4] first family chat");
    await page.waitForSelector(".chat", { timeout: 10_000 });
    console.log("  ✓ chat interface visible");

    // Test: Try sending empty message
    const sendBtn = await page.$("form.message-input button[type='submit']");
    const sendBtnDisabled = await sendBtn.evaluate((el) => el.disabled);
    if (!sendBtnDisabled) {
      logIssue(
        "Send button enabled with empty input",
        "The chat send button is enabled even when the input is empty."
      );
    } else {
      console.log("  ✓ send button correctly disabled with empty input");
    }

    // Test: Try submitting empty form via Enter
    await page.focus("form.message-input input");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    // Check no message was added (no kid message appeared)
    const msgCount = await page.$$eval(".message", (els) => els.length);
    if (msgCount > 0) {
      logIssue(
        "Empty message sent via Enter key",
        "Pressing Enter with empty input sent a message (or triggered a response)."
      );
    }

    // Send first real message
    const chatLine1 = "Hi sweetheart, what happened today?";
    console.log(`  sending: "${chatLine1}"`);
    await page.fill("form.message-input input", chatLine1);
    await page.click('form.message-input button[type="submit"]');

    // Wait for streaming to start, then complete
    await page.waitForTimeout(1000);

    // Wait for child's response to complete
    console.log("  waiting for child response...");
    await page.waitForSelector('[data-testid="btn-end-chat"]:not([disabled])', {
      timeout: LLM_TIMEOUT_MS,
    });
    console.log("  ✓ first child response received");

    // Check message count
    const messagesAfterFirst = await page.$$eval(".message", (els) => els.length);
    console.log(`  messages visible: ${messagesAfterFirst}`);

    // Send second message
    const chatLine2 = "That's okay, we're here for you.";
    console.log(`  sending: "${chatLine2}"`);
    await page.waitForSelector("form.message-input input:not([disabled])", {
      timeout: LLM_TIMEOUT_MS,
    });
    await page.fill("form.message-input input", chatLine2);
    await page.click('form.message-input button[type="submit"]');

    // Wait for response
    console.log("  waiting for second child response...");
    await page.waitForSelector('[data-testid="btn-end-chat"]:not([disabled])', {
      timeout: LLM_TIMEOUT_MS,
    });
    console.log("  ✓ second child response received");

    // Test: Check messages remaining dots
    const messageDots = await page.$$(".message-dot");
    console.log(`  message dots visible: ${messageDots.length}`);
    if (messageDots.length !== 12) {
      logIssue(
        "Message dots count mismatch",
        `Expected 12 message dots but found ${messageDots.length}`
      );
    }

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 5: END FIRST CHAT
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[phase 5] ending first chat");
    await page.click('[data-testid="btn-end-chat"]');

    // Should transition to processing screen
    console.log("  waiting for processing screen...");
    await page.waitForSelector(".processing-screen", { timeout: 10_000 });
    console.log("  ✓ processing screen visible");

    // Wait for processing to complete and move to debrief
    console.log("  waiting for psychologist processing to complete...");
    await page.waitForSelector(".debrief", { timeout: LLM_TIMEOUT_MS });
    console.log("  ✓ debrief screen visible");

    // Test: Check debrief has both options
    const nextEventBtn = await page.$('[data-testid="btn-next-event"]');
    const epilogueBtn = await page.$('[data-testid="btn-epilogue"]');
    console.log(`  next event button: ${nextEventBtn ? "present" : "MISSING"}`);
    console.log(`  epilogue button: ${epilogueBtn ? "present" : "MISSING"}`);

    if (!nextEventBtn || !epilogueBtn) {
      logIssue(
        "Missing buttons on debrief screen",
        `nextEvent: ${!!nextEventBtn}, epilogue: ${!!epilogueBtn}. Both should be present.`
      );
    }

    // Test: Double-click epilogue button (potential race condition)
    // Don't actually click it since we want to continue the game.
    // Just verify it exists.
    console.log("  ✓ both debrief action buttons present");

    // Click "next event" to continue
    console.log("\n[phase 6] proceed to second event");

    await page.click('[data-testid="btn-next-event"]');

    // Should auto-load next event
    await page.waitForSelector(".event-intro", { timeout: 10_000 });
    console.log("  ✓ event intro visible for second event");

    // Wait for event to load
    const enterBtn2 = await page.waitForSelector('[data-testid="btn-enter-event"]', {
      timeout: LLM_TIMEOUT_MS,
    });
    if (enterBtn2) {
      console.log("  ✓ second event loaded");
    }

    // Check the event is different
    const eventDescription2 = await page
      .$eval(".event-description", (el) => el.textContent)
      .catch(() => "");
    const ageMarker2 = await page.$eval(".age-marker", (el) => el.textContent).catch(() => "");
    console.log(`  ✓ second event: ${ageMarker2} - "${eventDescription2?.slice(0, 60)}..."`);

    if (eventDescription2 === eventDescription) {
      logIssue(
        "Same event loaded twice",
        "The second event has the same description as the first event. Events should be unique."
      );
    }

    // Enter second event
    await page.click('[data-testid="btn-enter-event"]');
    await page.waitForSelector(".chat", { timeout: 10_000 });
    console.log("  ✓ second chat started");

    // Send a message in second event
    const chatLine3 = "Tell me about your day, kiddo.";
    console.log(`  sending: "${chatLine3}"`);
    await page.waitForSelector("form.message-input input:not([disabled])", {
      timeout: LLM_TIMEOUT_MS,
    });
    await page.fill("form.message-input input", chatLine3);
    await page.click('form.message-input button[type="submit"]');

    console.log("  waiting for child response in second event...");
    await page.waitForSelector('[data-testid="btn-end-chat"]:not([disabled])', {
      timeout: LLM_TIMEOUT_MS,
    });
    console.log("  ✓ second event message exchanged");

    // End second chat
    console.log("\n[phase 7] ending second chat");
    await page.click('[data-testid="btn-end-chat"]');

    // Wait for processing then debrief
    console.log("  waiting for processing...");
    await page.waitForSelector(".processing-screen", { timeout: 10_000 });

    await page.waitForSelector('[data-testid="btn-epilogue"]', {
      timeout: LLM_TIMEOUT_MS,
    });
    console.log("  ✓ debrief screen reached after second chat");

    // ════════════════════════════════════════════════════════════════════════
    // PHASE 8: EPILOGUE
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n[phase 8] triggering epilogue");
    await page.click('[data-testid="btn-epilogue"]');

    // Should go to processing screen first, then epilogue
    console.log("  waiting for epilogue generation...");
    await page.waitForSelector(".endgame", { timeout: LLM_TIMEOUT_MS });
    console.log("  ✓ epilogue screen visible");

    // Test: Check epilogue content exists
    const epilogueText = await page.$eval(".endgame", (el) => el.textContent).catch(() => "");
    if (!epilogueText || epilogueText.trim().length < 10) {
      logIssue(
        "Epilogue screen has no content",
        "The epilogue screen is visible but has little or no text content."
      );
    } else {
      console.log(`  ✓ epilogue text: "${epilogueText.slice(0, 80)}..."`);
    }

    // Test: Continue to report card
    const continueBtn = await page.$('[data-testid="btn-continue"]');
    if (!continueBtn) {
      logIssue(
        "Missing continue button on epilogue",
        'The "continue" button (data-testid="btn-continue") is missing from the epilogue screen.'
      );
    }

    console.log("\n[phase 9] generating report card");
    await page.waitForSelector('[data-testid="btn-continue"]', { timeout: 5_000 });
    await page.click('[data-testid="btn-continue"]');

    // Wait for report card
    console.log("  waiting for report card generation...");
    await page.waitForSelector(".report-card", { timeout: LLM_TIMEOUT_MS });
    console.log("  ✓ report card visible!");

    // Test: Check report card content
    const reportCardHeading = await page
      .$eval(".report-card h1, .report-card h2", (el) => el.textContent)
      .catch(() => null);
    const reportCardContent = await page
      .$eval(".report-card", (el) => el.textContent)
      .catch(() => "");

    if (!reportCardContent || reportCardContent.trim().length < 10) {
      logIssue(
        "Report card has no content",
        "The report card screen is visible but has little or no text content."
      );
    } else {
      console.log(`  ✓ report card heading: ${reportCardHeading}`);
      console.log(`  ✓ report card content length: ${reportCardContent.length} chars`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // FINAL: COLLECT ALL ERRORS
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("PLAYTEST SUMMARY");
    console.log("═══════════════════════════════════════════════════════════");

    console.log(`\nConsole errors: ${consoleErrors.length}`);
    for (const err of consoleErrors.slice(0, 10)) {
      console.log(`  - ${err.slice(0, 120)}`);
    }

    console.log(`\nUncaught JS errors: ${uncaughtErrors.length}`);
    for (const err of uncaughtErrors.slice(0, 10)) {
      console.log(`  - ${err.slice(0, 120)}`);
    }

    console.log(`\nNetwork failures: ${networkErrors.length}`);
    for (const err of networkErrors.slice(0, 10)) {
      console.log(`  - ${err.method} ${err.url}: ${err.failure}`);
    }

    // Report console errors as issues if any
    if (consoleErrors.length > 0) {
      const uniqueErrors = [...new Set(consoleErrors)];
      for (const err of uniqueErrors.slice(0, 5)) {
        logIssue(
          "Console error during playthrough",
          `Browser console reported error: "${err.slice(0, 200)}"`,
          ["console-error"]
        );
      }
    }

    // Report uncaught JS errors as issues
    for (const err of uncaughtErrors.slice(0, 5)) {
      logIssue(
        "Uncaught JavaScript error",
        `Uncaught exception during playthrough: "${err.slice(0, 200)}"`,
        ["javascript-error"]
      );
    }

    // Report network failures as issues
    for (const err of networkErrors.slice(0, 5)) {
      logIssue(
        "Network request failure",
        `${err.method} ${err.url} failed: ${err.failure}`,
        ["network-error"]
      );
    }

    // Also check for: error banner that might have appeared
    const errorBanner = await page.$(".error-banner");
    if (errorBanner) {
      const errorText = await errorBanner.textContent();
      logIssue(
        "Error banner displayed during playthrough",
        `An error banner was visible: "${errorText?.slice(0, 200)}"`,
        ["error-banner"]
      );
    }

    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`ISSUES FOUND: ${issues.length}`);
    console.log(`═══════════════════════════════════════════════════════════`);

    for (const issue of issues) {
      console.log(`\n[${issue.labels.join(", ")}] ${issue.title}`);
      console.log(`  ${issue.body.slice(0, 120)}`);
    }

    // Output JSON
    console.log("\n\n=== JSON OUTPUT ===");
    console.log(JSON.stringify(issues, null, 2));
  } catch (err) {
    console.error("\n[playtest] FATAL ERROR:", err.message);
    console.error(err.stack);

    // Check what state we're in
    const currentUrl = page.url();
    console.error(`[playtest] Current URL: ${currentUrl}`);

    // Try to screenshot for debugging
    await page.screenshot({ path: "playtest-error.png" });
    console.error("[playtest] Error screenshot saved to playtest-error.png");

    logIssue(
      "Playtest script crashed",
      `Script crashed with: ${err.message}. URL at time of crash: ${currentUrl}`,
      ["script-error"]
    );
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("[playtest] UNHANDLED:", err);
  process.exit(1);
});
