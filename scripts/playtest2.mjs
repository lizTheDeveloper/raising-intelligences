import { chromium } from "playwright";

const issues = [];
const seen = new Set();
function record(title, body, labels = []) {
  const key = title + "|" + body;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push({ title, body, labels });
  console.log(`[ISSUE] ${title}`);
}
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

const BASE = "http://localhost:5173";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  const consoleLogs = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") consoleErrors.push(text);
    consoleLogs.push(`[${msg.type()}] ${text}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`PAGE: ${err.message}`));

  try {
    // Step 1: Start
    log("Starting game...");
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
    await page.click("button.btn-secondary");
    await page.waitForSelector("input.name-input", { timeout: 5000 });
    await page.fill("input.name-input", "Maya");
    await page.click("form button[type=submit]");
    await page.waitForSelector("div.guardian-screen", { timeout: 10000 });

    // Check images
    const imgs = await page.$$("div.guardian-intro-image img");
    let brokenImg = 0;
    for (const img of imgs) {
      const ok = await img.evaluate(el => el.complete && el.naturalWidth > 0);
      const src = await img.getAttribute("src");
      if (!ok) brokenImg++;
    }
    if (brokenImg > 0) {
      record("Some guardian intro images failed to load",
        `${brokenImg}/3 images broken — missing files served as HTML`, ["bug", "visual"]);
    }

    // Wait for guardian buttons
    log("Waiting for guardian buttons (up to 90s)...");
    await page.waitForSelector("div.guardian-buttons button", { timeout: 90000 });
    await page.click("div.guardian-buttons > button.btn:not(.dim)");
    log("✓ Guardian complete");

    // Step 2: Event intro
    log("Event intro...");
    await page.waitForSelector("div.event-intro", { timeout: 10000 });
    const spinner = await page.$("span.event-spinner");
    if (spinner) await page.waitForSelector("span.event-spinner", { state: "detached", timeout: 120000 });

    const desc = await page.textContent("p.event-description");
    log(`Event: ${desc?.slice(0, 80)}...`);

    await page.click("div.event-intro button.btn");

    // Step 3: Chat
    log("Chat started...");
    await page.waitForSelector("div.chat", { timeout: 5000 });

    // Monitor page state closely
    await page.waitForSelector("form.message-input input", { timeout: 5000 });
    const inputDisabled = await page.$eval("form.message-input input", el => el.disabled);
    log(`Input disabled: ${inputDisabled}`);

    // Type and send via form submission (most reliable)
    log("Sending message 1...");
    await page.fill("form.message-input input", "I'm here for you");

    // Click the send button
    const sendDisabled = await page.$eval("form.message-input button", el => el.disabled);
    log(`Send button disabled before click: ${sendDisabled}`);

    // Use evaluate to trigger submit directly
    await page.evaluate(() => {
      const form = document.querySelector("form.message-input");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    log("Form submitted, waiting for response...");

    // Wait up to 120s for streaming to end, checking periodically
    let waited = 0;
    while (waited < 120) {
      const state = await page.evaluate(() => {
        const btn = document.querySelector("form.message-input button[type=submit]");
        const input = document.querySelector("form.message-input input");
        const kidMsgs = document.querySelectorAll("div.message-kid");
        const parentMsgs = document.querySelectorAll("div.message-parent1");
        const streamingEl = document.querySelector(".message-kid:last-child .message-content");

        return {
          btnDisabled: btn?.disabled ?? "no btn",
          inputDisabled: input?.disabled ?? "no input",
          kidMsgCount: kidMsgs.length,
          parentMsgCount: parentMsgs.length,
          lastKidText: streamingEl?.textContent?.slice(-50) ?? "",
          bodySnippet: document.body.innerText.slice(0, 200)
        };
      });

      if (waited % 10 === 0) {
        log(`  [${waited}s] btn=${state.btnDisabled}, input=${state.inputDisabled}, kidMsgs=${state.kidMsgCount}, parentMsgs=${state.parentMsgCount}`);
        if (state.lastKidText) log(`    streaming: ...${state.lastKidText}`);
      }

      // Check if done (button re-enabled)
      if (state.btnDisabled === false) {
        log(`✓ Response complete at ${waited}s (kid messages: ${state.kidMsgCount})`);
        break;
      }

      await page.waitForTimeout(1000);
      waited++;
    }

    if (waited >= 120) {
      record("Kid response never completed", `Waited 120s, button still disabled. State: ${JSON.stringify(await page.evaluate(() => ({
        btnDisabled: document.querySelector("form.message-input button")?.disabled,
        kidMsgs: document.querySelectorAll("div.message-kid").length,
        consoleErrors: window.__consoleErrors || "N/A"
      })))}`, ["bug", "critical"]);
      await page.screenshot({ path: "debug-chat-timeout.png" });
    }

    // Step 4: End conversation
    log("Ending conversation...");
    const endBtn = await page.$("button.btn.btn-secondary");
    const endState = endBtn ? await endBtn.isDisabled() : "missing";
    log(`End button state: ${endState}`);

    if (endBtn && endState === false) {
      await endBtn.click();
      log("Clicked end conversation");

      // Wait for processing
      log("Waiting for debrief (up to 180s)...");
      try {
        await page.waitForSelector("div.processing-screen", { timeout: 15000 });
        log("✓ Processing screen");

        await page.waitForSelector("div.debrief-enhanced", { timeout: 180000 });
        log("✓ Debrief appeared!");

        // Step 5: Test "I'm not ready" on guardian
        // Actually test the epilogue path
        log("Testing epilogue...");
        const endChildBtn = await page.$('button.btn-secondary:has-text("end childhood")');
        if (endChildBtn) {
          await endChildBtn.click();
          log("Clicked 'end childhood'");

          await page.waitForSelector("div.endgame", { timeout: 180000 });
          log("✓ Epilogue!");

          const contBtn = await page.$("div.endgame-actions button.btn");
          if (contBtn) {
            await contBtn.click();
            await page.waitForSelector("div.report-card", { timeout: 180000 });
            log("✓ Report card!");
            const rcLen = await page.evaluate(() => (document.querySelector("div.report-card")?.textContent || "").length);
            log(`Report card: ${rcLen} chars`);
          }
        } else {
          record("'end childhood -> epilogue' button not found", "", ["bug"]);
        }

      } catch (err) {
        const state = await page.evaluate(() => document.body.innerText.slice(0, 400));
        record("Processing/debrief/epilogue failed", `${err.message}\nPage: ${state}`, ["bug", "flow"]);
        await page.screenshot({ path: "debug-flow-fail.png" });
      }
    } else {
      record("Could not end conversation", `End button: ${endState}`, ["bug"]);
    }

  } catch (err) {
    record("Test crashed", err.message, ["critical"]);
  }

  // Add console errors
  if (consoleErrors.length > 0) {
    record("Console errors", consoleErrors.slice(0, 10).join("\n"), ["bug", "frontend"]);
  }

  // Log all console output for debugging
  log(`\n=== Console output (${consoleLogs.length} entries) ===`);
  consoleLogs.forEach(l => log(`  ${l}`));

  await browser.close();

  log(`\n${"=".repeat(60)}`);
  log(`Total issues: ${issues.length}`);
  console.log("\nFINAL_ISSUES_JSON:");
  console.log(JSON.stringify(issues, null, 2));
})();
