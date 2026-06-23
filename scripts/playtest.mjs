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

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

const BASE = "http://localhost:5173";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  const serverErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("requestfailed", (req) => {
    // Skip analytics / non-game requests
    if (!req.url().includes("localhost")) return;
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().includes("localhost")) {
      serverErrors.push(`${res.status()} ${res.url()}`);
    }
  });

  try {
    // ═══════════════════════════════════════════════════════
    // Step 1: Open game
    // ═══════════════════════════════════════════════════════
    log("Step 1: Opening game...");
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForSelector("div.start-screen", { timeout: 10000 });
    log("✓ Start screen loaded");

    // ═══════════════════════════════════════════════════════
    // Step 2: Click "play solo" + enter name
    // ═══════════════════════════════════════════════════════
    log("Step 2: Start solo game...");
    await page.click("button.btn-secondary");
    await page.waitForSelector("input.name-input", { timeout: 5000 });
    await page.fill("input.name-input", "Maya");

    // Check begin button enable state
    const btnDisabledEmpty = await page.$eval("form button[type=submit]", (el) => el.disabled).catch(() => "missing");
    log(`  Begin btn disabled with empty input: ${btnDisabledEmpty}`);

    await page.click("form button[type=submit]");
    log("✓ Submitted name");

    // ═══════════════════════════════════════════════════════
    // Step 3: Guardian screen
    // ═══════════════════════════════════════════════════════
    log("Step 3: Guardian screen...");
    await page.waitForSelector("div.guardian-screen", { timeout: 10000 });

    // Check intro images
    const introImgs = await page.$$("div.guardian-intro-image img");
    for (let i = 0; i < introImgs.length; i++) {
      const src = await introImgs[i].getAttribute("src");
      const ok = await introImgs[i].evaluate((el) => el.complete && el.naturalWidth > 0);
      if (!ok) record("Guardian intro image failed to load", `Image: ${src} — served as text/html (SPA fallback) because file doesn't exist`, ["bug", "visual", "missing-assets"]);
    }

    // Wait for buttons (up to 90s for event generation)
    log("  Waiting for guardian buttons...");
    await page.waitForSelector("div.guardian-buttons button", { timeout: 90000 });
    log("✓ Guardian buttons appeared");

    // Click "I'm ready" (FIRST button, before clicking not-ready which hides everything)
    await page.click("div.guardian-buttons > button.btn:not(.dim)");
    log("✓ Clicked 'I'm ready'");

    // ═══════════════════════════════════════════════════════
    // Step 4: First event intro
    // ═══════════════════════════════════════════════════════
    log("Step 4: First event intro...");
    await page.waitForSelector("div.event-intro", { timeout: 15000 });

    // Wait for event generation if spinner is showing
    const spinner = await page.$("span.event-spinner");
    if (spinner) {
      log("  Event generating...");
      await page.waitForSelector("span.event-spinner", { state: "detached", timeout: 120000 });
    }

    const eventDesc = await page.textContent("p.event-description").catch(() => null);
    const eventAge = await page.textContent("p.age-marker").catch(() => null);
    log(`  Age: ${eventAge}, Description: ${eventDesc?.slice(0, 80)}...`);

    if (!eventDesc || eventDesc.trim().length === 0) {
      record("Event description is empty", `age: ${eventAge}`, ["bug"]);
    }

    // Click "enter"
    await page.click("div.event-intro button.btn");
    log("✓ Entered chat");

    // ═══════════════════════════════════════════════════════
    // Step 5: First chat — send 2 messages
    // ═══════════════════════════════════════════════════════
    log("Step 5: Chat (event 1)...");
    await page.waitForSelector("div.chat", { timeout: 10000 });

    const chatMessages = [
      "It's going to be okay, I'm here for you.",
      "You're very brave for talking about this."
    ];

    for (let i = 0; i < chatMessages.length; i++) {
      log(`  Sending: "${chatMessages[i]}"`);
      const input = await page.waitForSelector("form.message-input input", { timeout: 5000 });

      // Check if input is disabled
      const inputDisabled = await input.isDisabled();
      if (inputDisabled) {
        record("Chat input disabled between messages", `Input disabled after message ${i}`, ["bug"]);
        break;
      }

      await input.fill(chatMessages[i]);
      
      // Try clicking send, otherwise press Enter
      const sendBtn = await page.$("form.message-input button");
      const sendDisabled = sendBtn ? await sendBtn.isDisabled() : true;
      
      if (sendDisabled) {
        await input.press("Enter");
      } else {
        await sendBtn.click();
      }

      // Wait for kid response — watch for a new .message-kid element.
      // (The send button stays disabled while text is empty, so it's not a
      // reliable signal here — using message count instead.)
      const kidBefore = await page.$$eval("div.message.message-kid", (els) => els.length);
      log(`  Waiting for kid response (have ${kidBefore} kid messages)...`);
      try {
        await page.waitForFunction(
          (before) => document.querySelectorAll("div.message.message-kid").length > before,
          kidBefore,
          { timeout: 60000 }
        );
        log("  ✓ Response received");
      } catch {
        record("Kid response timed out", `After message ${i + 1}, still ${kidBefore} kid messages after 60s`, ["bug"]);
      }

      const kidMsgs = await page.$$("div.message.message-kid");
      log(`  Kid messages now: ${kidMsgs.length}`);
    }

    // ═══════════════════════════════════════════════════════
    // Step 6: End first conversation
    // ═══════════════════════════════════════════════════════
    log("Step 6: End conversation 1...");
    const endConvBtn = await page.$("button.btn.btn-secondary");
    if (!endConvBtn) {
      record("End conversation button missing", "No .btn.btn-secondary in chat", ["bug"]);
    } else {
      const endDisabled = await endConvBtn.isDisabled();
      if (endDisabled) {
        record("End conversation button stuck disabled", "Button disabled after chatting", ["bug"]);
      } else {
        await endConvBtn.click();
        log("✓ Clicked 'end conversation'");
      }
    }

    // ═══════════════════════════════════════════════════════
    // Step 7: Processing -> Debrief (timeout 120s for LLM)
    // ═══════════════════════════════════════════════════════
    log("Step 7: Processing screen...");
    try {
      await page.waitForSelector("div.processing-screen", { timeout: 10000 });
      log("✓ Processing screen appeared");

      // Wait for debrief — the LLM call can take a while
      log("  Waiting for debrief (up to 120s)...");
      await page.waitForSelector("div.debrief-enhanced", { timeout: 120000 });
      log("✓ Debrief screen appeared");

      const debriefText = await page.textContent("div.debrief-enhanced").catch(() => "");
      log(`  Debrief content: ${debriefText.slice(0, 100)}...`);

    } catch (err) {
      // Check current page state for debugging
      const currentPhase = await page.evaluate(() => {
        const body = document.body.innerText;
        if (document.querySelector("div.processing-screen")) return "processing";
        if (document.querySelector("div.debrief-enhanced")) return "debrief";
        if (document.querySelector("div.chat")) return "chat";
        if (document.querySelector("div.event-intro")) return "event_intro";
        if (document.querySelector("div.guardian-screen")) return "guardian";
        if (document.querySelector(".error-banner")) return "error: " + document.querySelector(".error-banner")?.textContent;
        return "unknown: " + body.slice(0, 200);
      });
      record("Processing -> debrief failed", `Timeout waiting for debrief. Current phase: ${currentPhase}. Error: ${err.message}`, ["bug", "flow"]);
      
      await page.screenshot({ path: "debug-processing-timeout.png" });
      log("  Saved debug screenshot: debug-processing-timeout.png");
    }

    // ═══════════════════════════════════════════════════════
    // Step 8: Second event
    // ═══════════════════════════════════════════════════════
    log("Step 8: Next event...");
    try {
      // Wait for debrief to be on screen
      await page.waitForSelector("div.debrief-enhanced", { timeout: 5000 });
      
      const nextEventBtn = await page.$("div.debrief-enhanced button.btn");
      if (nextEventBtn) {
        await nextEventBtn.click();
        log("✓ Clicked 'next event'");
      } else {
        record("'next event' button missing on debrief", "", ["bug"]);
        throw new Error("no next event btn");
      }

      // Wait for event intro
      await page.waitForSelector("div.event-intro", { timeout: 30000 });
      const spinner2 = await page.$("span.event-spinner");
      if (spinner2) {
        log("  Event 2 generating...");
        await page.waitForSelector("span.event-spinner", { state: "detached", timeout: 120000 });
      }
      
      const age2 = await page.textContent("p.age-marker").catch(() => null);
      const desc2 = await page.textContent("p.event-description").catch(() => null);
      log(`  Event 2: age=${age2}, desc=${desc2?.slice(0, 60)}...`);

      if (age2 === eventAge) {
        record("Age didn't advance between events", `Both events: ${age2}`, ["bug"]);
      }

      await page.click("div.event-intro button.btn");
      log("✓ Entered chat 2");

      // ═══════════════════════════════════════════════════════
      // Step 9: Chat 2
      // ═══════════════════════════════════════════════════════
      await page.waitForSelector("div.chat", { timeout: 10000 });
      log("Step 9: Chat (event 2)...");

      for (let i = 0; i < 2; i++) {
        const input = await page.$("form.message-input input");
        if (!input) { record("Chat input missing", `Event 2, message ${i}`, ["bug"]); break; }
        await input.fill(`Message ${i + 1} in chat 2`);
        const btn = await page.$("form.message-input button");
        if (btn && !(await btn.isDisabled())) {
          await btn.click();
        } else {
          await input.press("Enter");
        }
        const kidBefore2 = await page.$$eval("div.message.message-kid", (els) => els.length);
        try {
          await page.waitForFunction(
            (before) => document.querySelectorAll("div.message.message-kid").length > before,
            kidBefore2,
            { timeout: 60000 }
          );
          log("  ✓ Response received");
        } catch {
          record("Second chat response timed out", `Message ${i + 1} in event 2, still ${kidBefore2} kid messages after 60s`, ["bug"]);
        }
      }

      // ═══════════════════════════════════════════════════════
      // Step 10: End chat 2 -> debrief 2
      // ═══════════════════════════════════════════════════════
      log("Step 10: End conversation 2...");
      const endBtn2 = await page.$("button.btn.btn-secondary");
      if (endBtn2 && !(await endBtn2.isDisabled())) {
        await endBtn2.click();
        log("✓ Ended conversation 2");
      }

      await page.waitForSelector("div.debrief-enhanced", { timeout: 120000 });
      log("✓ Debrief 2 appeared");

      // ═══════════════════════════════════════════════════════
      // Step 11: End childhood -> epilogue
      // ═══════════════════════════════════════════════════════
      log("Step 11: End childhood -> epilogue...");
      
      // "end childhood -> epilogue" is a separate btn-secondary below debrief
      const endChildBtn = await page.$('button.btn.btn-secondary:has-text("end childhood")')
        || await page.$('button.btn.btn-secondary').then(async (btns) => {
          // Could also be at a lower level — SoloGame renders it
          const allSecBtns = await page.$$("button.btn-secondary");
          for (const b of allSecBtns) {
            const text = await b.textContent();
            if (text?.includes("end childhood")) return b;
          }
          return null;
        });

      if (endChildBtn) {
        await endChildBtn.click();
        log("✓ Clicked 'end childhood'");
      } else {
        record("'end childhood -> epilogue' button missing", "", ["bug"]);
      }

      // ═══════════════════════════════════════════════════════
      // Step 12: Epilogue
      // ═══════════════════════════════════════════════════════
      log("Step 12: Waiting for epilogue...");
      try {
        // Might go through processing first
        await page.waitForSelector("div.endgame, div.processing-screen", { timeout: 10000 });
        if (await page.$("div.processing-screen")) {
          log("  Processing epilogue...");
          await page.waitForSelector("div.endgame", { timeout: 120000 });
        }
        log("✓ Epilogue appeared");

        const epilogueParas = await page.$$("p.epilogue-para");
        log(`  Epilogue paragraphs: ${epilogueParas.length}`);
        if (epilogueParas.length === 0) {
          record("Empty epilogue", "No paragraphs shown", ["bug"]);
        }
        const epilogueText = await page.textContent("div.endgame").catch(() => "");
        log(`  Epilogue preview: ${epilogueText.slice(0, 120)}...`);

        // Continue to report card
        const contBtn = await page.$("div.endgame-actions button.btn");
        if (contBtn) {
          await contBtn.click();
          log("✓ Clicked 'continue' to report card");
        } else {
          record("'continue' button missing after epilogue", "", ["bug"]);
        }
      } catch (err) {
        const currentPhase = await page.evaluate(() => document.body.innerText.slice(0, 300));
        record("Epilogue flow broken", `Error: ${err.message}. Page state: ${currentPhase}`, ["bug", "flow"]);
      }

      // ═══════════════════════════════════════════════════════
      // Step 13: Report card
      // ═══════════════════════════════════════════════════════
      log("Step 13: Report card...");
      try {
        if (await page.$("div.processing-screen")) {
          log("  Processing report card...");
        }
        await page.waitForSelector("div.report-card", { timeout: 120000 });
        log("✓ Report card appeared!");

        await page.waitForTimeout(3000); // Let content render
        const rcText = await page.textContent("div.report-card").catch(() => "");
        log(`  Report card length: ${rcText?.length ?? 0} chars`);
        log(`  Preview: ${rcText?.slice(0, 200)}...`);

        if (!rcText || rcText.trim().length < 50) {
          record("Report card empty or near-empty", `Length: ${rcText?.length ?? 0}`, ["bug"]);
        }
      } catch (err) {
        const state = await page.evaluate(() => document.body.innerText.slice(0, 300));
        record("Report card never appeared", `Error: ${err.message}. Page: ${state}`, ["bug", "flow"]);
      }

    } catch (err) {
      log(`Steps 8-13 failed: ${err.message}`);
      await page.screenshot({ path: "debug-early-failure.png" });
    }

  } catch (err) {
    record("Playtest crashed", err.message, ["critical"]);
  }

  // ═══════════════════════════════════════════════════════
  // Final issues from browser events
  // ═══════════════════════════════════════════════════════
  if (consoleErrors.length > 0) {
    record("JS console errors during playthrough", consoleErrors.join("\n"), ["bug", "frontend"]);
  }

  if (failedRequests.length > 0) {
    record("Failed network requests", failedRequests.join("\n"), ["bug", "network"]);
  }

  if (serverErrors.length > 0) {
    record("Server HTTP errors (4xx/5xx)", serverErrors.join("\n"), ["bug", "server"]);
  }

  await browser.close();

  // Output final JSON
  log(`\n${"=".repeat(60)}`);
  log(`Total unique issues: ${issues.length}`);
  log(`${"=".repeat(60)}`);
  console.log("\nFINAL_ISSUES_JSON:");
  console.log(JSON.stringify(issues, null, 2));
})();
