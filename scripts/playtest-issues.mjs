#!/usr/bin/env node
/**
 * Playtest script: walks through entire solo game flow, documenting issues.
 * Tests: start screen → mode select → guardian → 2 events with chat → debrief → epilogue → report card.
 */
import { chromium } from "playwright";

const BASE_URL = process.argv[2] || "http://localhost:5173";
const CHILD_NAME = "Aria";
const LLM_TIMEOUT = 120_000;
const PHASE_TIMEOUT = 30_000;
const issues = [];

function logIssue(title, body, labels = ["playtest"]) {
  issues.push({ title, body, labels });
  console.log(`  [ISSUE] ${title}`);
}

async function waitForStreamingDone(page, timeout = LLM_TIMEOUT) {
  await page.waitForSelector('form.message-input input:not([disabled])', { timeout });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const networkErrors = [];
  const uncaughtErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => uncaughtErrors.push(err.message));
  page.on("requestfailed", (req) => {
    networkErrors.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText });
  });

  try {
    // ═══ PHASE 1: Start Screen (mode choice) ═══
    console.log("\n[1] Start screen");
    await page.goto(BASE_URL, { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForSelector(".mode-choice", { timeout: 10_000 });

    const title = await page.$eval("h1", (el) => el.textContent).catch(() => "");
    if (title.trim() !== "raising intelligences") {
      logIssue("Start screen title mismatch", `Expected 'raising intelligences', got '${title.trim()}'`);
    } else {
      console.log("  ✓ Title correct");
    }

    const tagline = await page.$eval(".start-screen .dim", (el) => el.textContent).catch(() => "");
    if (!tagline?.trim()) {
      logIssue("Missing tagline", "No tagline text on start screen");
    } else {
      console.log(`  ✓ Tagline: "${tagline.trim()}"`);
    }

    // Both mode buttons should be visible
    const soloBtn = await page.$(".mode-choice .btn-secondary");
    const multiBtn = await page.$(".mode-choice .btn:not(.btn-secondary)");
    if (!soloBtn) logIssue("Missing 'play solo' button", "Solo mode button not found on start screen");
    if (!multiBtn) logIssue("Missing 'play with a partner' button", "Multiplayer button not found on start screen");

    // Click "play solo"
    await page.click(".mode-choice .btn-secondary");
    await page.waitForSelector("input.name-input", { timeout: 10_000 });
    console.log("  ✓ Solo game name input visible");

    // ═══ PHASE 2: Name Input ═══
    console.log("\n[2] Name input");

    // Begin button disabled with empty input
    const beginDisabled = await page.$eval('form button[type="submit"]', (el) => el.disabled);
    if (!beginDisabled) {
      logIssue("Begin button enabled with empty name", "Button should be disabled when name input is empty");
    } else {
      console.log("  ✓ Begin button disabled with empty input");
    }

    // Whitespace-only name should also be disabled
    await page.fill("input.name-input", "   ");
    const beginAfterSpaces = await page.$eval('form button[type="submit"]', (el) => el.disabled);
    console.log(`  Whitespace-only name: begin button disabled=${beginAfterSpaces}`);
    if (!beginAfterSpaces) {
      logIssue("Begin button enabled with whitespace name", "Button appears enabled with spaces-only input");
    }

    // Enter real name and submit
    await page.fill("input.name-input", CHILD_NAME);
    await page.click('form button[type="submit"]');
    console.log(`  ✓ Created game with name: ${CHILD_NAME}`);

    // ═══ PHASE 3: Guardian Screen ═══
    console.log("\n[3] Guardian screen");
    await page.waitForSelector(".guardian-screen", { timeout: PHASE_TIMEOUT });

    const guardianName = await page.$eval(".guardian-name", (el) => el.textContent).catch(() => "");
    if (guardianName !== CHILD_NAME) {
      logIssue("Guardian name mismatch", `Expected '${CHILD_NAME}', got '${guardianName}'`);
    } else {
      console.log("  ✓ Child name shown correctly");
    }

    // Wait for the ready button to become enabled (portrait + event both loaded)
    console.log("  Waiting for guardian ready button...");
    await page.waitForSelector('.guardian-screen button.btn:not([disabled])', { timeout: LLM_TIMEOUT });
    const readyText = await page.$eval('.guardian-screen button.btn', (el) => el.textContent?.trim());
    console.log(`  ✓ Ready button enabled: "${readyText}"`);

    if (readyText !== "I'm ready") {
      logIssue("Guardian button text unexpected", `Expected "I'm ready", got "${readyText}"`);
    }

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-guardian-ready.png" });

    // Click ready
    await page.click('.guardian-screen button.btn');

    // Guardian screen should transition away
    console.log("  Waiting for guardian screen to dismiss...");
    await page.waitForSelector(".guardian-screen", { state: "detached", timeout: 10_000 }).catch(() => {
      console.log("  ⏳ Guardian screen lingering, checking for next phase...");
    });

    // ═══ PHASE 4: First Event Intro ═══
    console.log("\n[4] First event intro");
    await page.waitForSelector(".event-intro", { timeout: LLM_TIMEOUT });

    // Wait for the event to be fully loaded — description element signals actual content
    await page.waitForSelector(".event-description", { timeout: LLM_TIMEOUT });
    console.log("  ✓ Event loaded, enter button visible");

    const eventDesc1 = await page.$eval(".event-description", (el) => el.textContent).catch(() => "");
    const ageMarker1 = await page.$eval(".age-marker", (el) => el.textContent).catch(() => "");
    console.log(`  ✓ Event: ${ageMarker1} - "${eventDesc1?.slice(0, 60)}..."`);

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-event1-intro.png" });

    // Click the "enter" button (only present when event is loaded)
    await page.click(".event-intro button.btn");
    await page.waitForSelector(".chat", { timeout: 10_000 });
    console.log("  ✓ Chat interface visible");

    // ═══ PHASE 5: First Family Chat ═══
    console.log("\n[5] First family chat");

    const sendDisabled = await page.$eval('form.message-input button[type="submit"]', (el) => el.disabled);
    if (!sendDisabled) {
      logIssue("Send button enabled with empty input", "Send should be disabled when input is empty");
    } else {
      console.log("  ✓ Send button correctly disabled");
    }

    const dots = await page.$$(".message-dot");
    console.log(`  Message dots: ${dots.length}`);
    if (dots.length !== 12) {
      logIssue("Wrong number of message dots", `Expected 12 dots, found ${dots.length}`);
    }

    const msg1 = "Hi sweetheart, what happened today?";
    await page.fill("form.message-input input", msg1);
    await page.click('form.message-input button[type="submit"]');
    console.log(`  Sent: "${msg1}"`);

    await waitForStreamingDone(page);
    console.log("  ✓ First response received");

    const msgs1 = await page.$$eval(".message", (els) => els.length);
    console.log(`  Messages visible: ${msgs1}`);
    if (msgs1 < 2) {
      logIssue("Fewer than 2 messages after first exchange", `Expected parent + kid = 2 messages, got ${msgs1}`);
    }

    const msg2 = "That's okay, we're here for you.";
    await page.fill("form.message-input input", msg2);
    await page.click('form.message-input button[type="submit"]');
    console.log(`  Sent: "${msg2}"`);

    await waitForStreamingDone(page);
    console.log("  ✓ Second response received");

    const msgs2 = await page.$$eval(".message", (els) => els.length);
    console.log(`  Messages visible: ${msgs2}`);

    const kidSenders = await page.$$eval(".message-kid .message-sender", (els) => els.map(e => e.textContent));
    console.log(`  Kid sender labels: ${JSON.stringify(kidSenders)}`);
    const allKidLabelsCorrect = kidSenders.every(s => s.trim().toLowerCase() === CHILD_NAME.toLowerCase());
    if (!allKidLabelsCorrect && kidSenders.length > 0) {
      logIssue("Kid message sender label mismatch", `Expected '${CHILD_NAME}' but got ${JSON.stringify(kidSenders)}`);
    }

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-chat1.png" });

    // ═══ PHASE 6: End First Chat ═══
    console.log("\n[6] Ending first chat");
    // "end conversation" button
    await page.click('button.btn-secondary');

    await page.waitForSelector(".processing-screen", { timeout: 10_000 });
    console.log("  ✓ Processing screen visible");

    await page.waitForSelector(".debrief-enhanced, .debrief", { timeout: LLM_TIMEOUT }).catch(async () => {
      const errBanner = await page.$(".error-banner");
      if (errBanner) {
        const errText = await errBanner.textContent();
        logIssue("Error during chat ending", `Error banner: ${errText}`);
      }
      throw new Error("Debrief screen never appeared");
    });
    console.log("  ✓ Debrief screen visible");

    // Check debrief buttons
    const nextBtn = await page.$(".debrief-enhanced button.btn");
    const epiBtn = await page.$('.debrief button.btn-secondary, button.btn-secondary');
    if (!nextBtn) logIssue("Missing 'next event' button on debrief", "Should have a next-event button");
    if (!epiBtn) logIssue("Missing 'end childhood' button on debrief", "Should have an epilogue button");
    console.log(`  Next event: ${nextBtn ? "✓" : "MISSING"}, End childhood: ${epiBtn ? "✓" : "MISSING"}`);

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-debrief1.png" });

    // ═══ PHASE 7: Second Event ═══
    console.log("\n[7] Second event");
    await page.click(".debrief-enhanced button.btn");
    await page.waitForSelector(".event-intro", { timeout: 10_000 });

    // After endDebrief, currentEvent is null — EventIntro shows "begin" button.
    // Click it to trigger the event fetch, then wait for the description to appear.
    await page.waitForSelector(".event-intro button.btn", { timeout: 10_000 });
    await page.click(".event-intro button.btn");
    await page.waitForSelector(".event-description", { timeout: LLM_TIMEOUT });

    const eventDesc2 = await page.$eval(".event-description", (el) => el.textContent).catch(() => "");
    const ageMarker2 = await page.$eval(".age-marker", (el) => el.textContent).catch(() => "");
    console.log(`  ✓ Event: ${ageMarker2} - "${eventDesc2?.slice(0, 60)}..."`);

    if (eventDesc1 === eventDesc2 && eventDesc1) {
      logIssue("Duplicate event", "Second event has identical description to first event");
    }

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-event2-intro.png" });

    // Now click "enter" (button text changed from "begin" to "enter")
    await page.click(".event-intro button.btn");
    await page.waitForSelector(".chat", { timeout: 10_000 });
    console.log("  ✓ Second chat visible");

    const msg3 = "Tell me about your day, kiddo.";
    await page.waitForSelector("form.message-input input:not([disabled])", { timeout: LLM_TIMEOUT });
    await page.fill("form.message-input input", msg3);
    await page.click('form.message-input button[type="submit"]');
    console.log(`  Sent: "${msg3}"`);

    await waitForStreamingDone(page);
    console.log("  ✓ Second event message exchanged");

    // ═══ PHASE 8: End Second Chat → Epilogue ═══
    console.log("\n[8] Ending second chat");
    await page.click('button.btn-secondary');
    await page.waitForSelector(".processing-screen", { timeout: 10_000 });
    console.log("  ✓ Processing screen visible");

    // Wait for debrief with epilogue button
    await page.waitForSelector(".debrief-enhanced, .debrief", { timeout: LLM_TIMEOUT });
    console.log("  ✓ Debrief screen reached");

    // Click "end childhood → epilogue"
    console.log("\n[9] Triggering epilogue");
    // The epilogue button is in .debrief (sibling of .debrief-enhanced), text "end childhood → epilogue"
    const epiButton = await page.locator('.debrief button.btn-secondary').first();
    await epiButton.click();

    console.log("  Waiting for epilogue generation...");
    await page.waitForSelector(".endgame", { timeout: LLM_TIMEOUT }).catch(async () => {
      const errBanner = await page.$(".error-banner");
      if (errBanner) {
        const errText = await errBanner.textContent();
        logIssue("Error during epilogue generation", `Error banner: ${errText}`);
      }
      throw new Error("Epilogue never appeared");
    });
    console.log("  ✓ Epilogue screen visible");

    const epilogueText = await page.$eval(".endgame", (el) => el.textContent).catch(() => "");
    if (!epilogueText || epilogueText.trim().length < 20) {
      logIssue("Epilogue has little content", `Epilogue text length: ${epilogueText?.trim().length || 0} chars`);
    } else {
      console.log(`  ✓ Epilogue text (${epilogueText.trim().length} chars)`);
    }

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-epilogue.png" });

    // ═══ PHASE 10: Report Card ═══
    console.log("\n[10] Generating report card");
    const continueBtn = await page.waitForSelector(".endgame button.btn", { timeout: 10_000 });
    if (!continueBtn) {
      logIssue("Missing continue button on epilogue", "Can't proceed to report card without this button");
    }
    await page.click(".endgame button.btn");

    console.log("  Waiting for report card generation...");
    await page.waitForSelector(".report-card", { timeout: LLM_TIMEOUT }).catch(async () => {
      const errBanner = await page.$(".error-banner");
      if (errBanner) {
        const errText = await errBanner.textContent();
        logIssue("Error during report card generation", `Error banner: ${errText}`);
      }
      throw new Error("Report card never appeared");
    });
    console.log("  ✓ Report card visible");

    const reportContent = await page.$eval(".report-card", (el) => el.textContent).catch(() => "");
    if (!reportContent || reportContent.trim().length < 20) {
      logIssue("Report card has little content", `Content length: ${reportContent?.trim().length || 0} chars`);
    } else {
      console.log(`  ✓ Report card content (${reportContent.trim().length} chars)`);
    }

    const reportHeading = await page.$eval(".report-card h1", (el) => el.textContent).catch(() => "");
    console.log(`  ✓ Report card heading: "${reportHeading}"`);

    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-reportcard.png" });

    // ═══ SUMMARY ═══
    console.log("\n═══════════════════════════════════");
    console.log("PLAYTEST SUMMARY");
    console.log("═══════════════════════════════════");

    console.log(`\nConsole errors: ${consoleErrors.length}`);
    const uniqueConsoleErrors = [...new Set(consoleErrors)];
    for (const err of uniqueConsoleErrors.slice(0, 10)) {
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

    // Known false positives — do not re-file
    const KNOWN_FP = [
      /404.*Not Found/,  // intro portraits (#49)
      /ERR_ABORTED/,     // portrait long-poll abort on navigation (#71)
    ];
    const isFP = (msg) => KNOWN_FP.some(re => re.test(msg));

    for (const err of uniqueConsoleErrors.slice(0, 5)) {
      if (!isFP(err)) logIssue("Console error during playthrough", `Browser console error: "${err.slice(0, 300)}"`, ["console-error"]);
    }
    for (const err of uncaughtErrors.slice(0, 5)) {
      logIssue("Uncaught JS error", `Uncaught exception: "${err.slice(0, 300)}"`, ["javascript-error"]);
    }
    for (const err of networkErrors.slice(0, 5)) {
      if (!isFP(err.failure || "") && !isFP(err.url)) {
        logIssue("Network request failure", `${err.method} ${err.url} failed: ${err.failure}`, ["network-error"]);
      }
    }

    const errorBanner = await page.$(".error-banner");
    if (errorBanner) {
      const errorText = await errorBanner.textContent();
      logIssue("Error banner visible", `Error banner text: "${errorText?.slice(0, 200)}"`, ["error-banner"]);
    }

    console.log(`\n───────────────────────────────────`);
    console.log(`TOTAL ISSUES: ${issues.length}`);
    console.log(`───────────────────────────────────`);

    for (const issue of issues) {
      console.log(`\n  [${issue.labels.join(", ")}] ${issue.title}`);
      console.log(`    ${issue.body.slice(0, 150)}`);
    }

    console.log("\n\n=== JSON OUTPUT ===");
    console.log(JSON.stringify(issues, null, 2));

  } catch (err) {
    console.error("\n[FATAL]", err.message);
    await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-fatal.png" }).catch(() => {});
    console.error("Screenshot saved to playtest-fatal.png");

    logIssue("Playtest crashed", `Error: ${err.message}\nURL: ${page.url()}`, ["fatal"]);
    console.log("\n=== JSON OUTPUT ===");
    console.log(JSON.stringify(issues, null, 2));
  } finally {
    await browser.close();
  }
}

run();
