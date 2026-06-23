import { chromium } from "playwright";

const issues = [];
const logs = [];

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  logs.push(line);
  console.log(line);
}

function recordIssue(title, body, labels = []) {
  issues.push({ title, body, labels });
  log(`ISSUE: ${title}`);
}

const BASE = "http://localhost:5173";

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Collect console errors and network errors
  const consoleErrors = [];
  const networkErrors = [];
  const failedRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
      log(`CONSOLE ERROR: ${msg.text()}`);
    }
  });

  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
    log(`PAGE ERROR: ${err.message}`);
  });

  page.on("requestfailed", (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
    log(`NETWORK FAIL: ${req.url()} - ${req.failure()?.errorText}`);
  });

  page.on("response", (res) => {
    if (res.status() >= 400) {
      networkErrors.push({ url: res.url(), status: res.status() });
      log(`HTTP ERROR: ${res.status()} ${res.url()}`);
    }
  });

  try {
    // ── Step 1: Open the game ──
    log("Step 1: Opening game...");
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForSelector("div.start-screen", { timeout: 10000 });

    // Check title and buttons
    const title = await page.textContent("h1");
    log(`Title: "${title}"`);
    if (!title?.toLowerCase().includes("raising intelligences")) {
      recordIssue("Missing or incorrect title", `Expected 'raising intelligences', got '${title}'`, ["bug"]);
    }

    const soloBtn = await page.$("button.btn-secondary");
    const partnerBtn = await page.$("button.btn:not(.btn-secondary)");
    log(`Solo button: ${!!soloBtn}, Partner button: ${!!partnerBtn}`);

    // Check theme picker
    const themeButtons = await page.$$("button.theme-btn");
    log(`Theme buttons found: ${themeButtons.length}`);
    if (themeButtons.length !== 3) {
      recordIssue("Theme picker has wrong number of buttons", `Expected 3 theme buttons, found ${themeButtons.length}`, ["bug"]);
    }

    // ── Step 2: Start solo game ──
    log("Step 2: Starting solo game...");
    await soloBtn.click();
    await page.waitForSelector("input.name-input", { timeout: 5000 });
    log("Name entry screen appeared");

    // Verify the begin button is disabled before entering a name
    const beginDisabled = await page.$("form button.btn[type=submit]");
    const isDisabledBeforeText = await beginDisabled?.getAttribute("disabled");
    if (isDisabledBeforeText === null) {
      recordIssue("Begin button not disabled on empty input", "The 'begin' button should be disabled when no name is entered", ["bug", "ux"]);
    } else {
      log("Begin button correctly disabled on empty input");
    }

    // Enter a child name
    const childName = "Maya";
    await page.fill("input.name-input", childName);
    log(`Entered name: ${childName}`);

    // Check begin button is now enabled
    const isDisabledAfterText = await page.$eval("form button.btn[type=submit]", el => el.disabled);
    log(`Begin button disabled after text: ${isDisabledAfterText}`);
    if (isDisabledAfterText) {
      recordIssue("Begin button still disabled after entering name", "Button should enable when name field has text", ["bug"]);
    }

    // Submit
    await page.click("form button.btn[type=submit]");
    log("Submitted name form");

    // ── Step 3: Guardian Screen ──
    log("Step 3: Guardian screen...");
    try {
      await page.waitForSelector("div.guardian-screen", { timeout: 10000 });
      log("Guardian screen appeared");

      // Check child name is shown
      const guardianName = await page.textContent("h2.guardian-name");
      log(`Guardian screen name: "${guardianName}"`);

      // Wait for intro images to load or fail
      const introImages = await page.$$("div.guardian-intro-image img");
      log(`Intro images: ${introImages.length}`);
      for (let i = 0; i < introImages.length; i++) {
        const src = await introImages[i].getAttribute("src");
        const naturalWidth = await introImages[i].evaluate(el => el.naturalWidth);
        log(`  Image ${i}: src=${src}, naturalWidth=${naturalWidth}`);
        if (naturalWidth === 0 && src) {
          recordIssue("Guardian intro image failed to load", `Image src: ${src}, naturalWidth=0`, ["bug", "visual"]);
        }
      }

      // Wait for the buttons to appear (intro completes + event ready)
      log("Waiting for guardian buttons...");
      await page.waitForSelector("div.guardian-buttons button", { timeout: 60000 });
      log("Guardian buttons appeared");

      // Check "I'm not ready" button flow
      const notReadyBtn = await page.$("div.guardian-buttons button.btn.dim");
      if (notReadyBtn) {
        await notReadyBtn.click();
        log("Clicked 'I'm not ready'");
        const notReadyMsg = await page.waitForSelector("p.guardian-not-ready-message", { timeout: 5000 });
        const msgText = await notReadyMsg.textContent();
        log(`Not ready message: "${msgText}"`);
      }

      // Click "I'm ready"
      await page.click("div.guardian-buttons > button.btn:first-child");
      log("Clicked 'I'm ready'");
    } catch (err) {
      recordIssue("Guardian screen flow broken", err.message, ["bug", "critical"]);
      // Try to recover by continuing
    }

    // ── Step 4: First Life Event Intro ──
    log("Step 4: First life event intro...");
    try {
      // Could go to event_intro directly, or might need to wait
      await page.waitForSelector("div.event-intro", { timeout: 30000 });
      log("Event intro screen appeared");

      // Check if event is loading or ready
      const isGenerating = await page.$("span.event-spinner");
      if (isGenerating) {
        log("Event is generating, waiting...");
        await page.waitForSelector("span.event-spinner", { state: "detached", timeout: 60000 });
        log("Event generation complete");
      }

      // Read event description
      const ageEl = await page.$("p.age-marker");
      const descEl = await page.$("p.event-description");
      const ageText = ageEl ? await ageEl.textContent() : "(none)";
      const descText = descEl ? await descEl.textContent() : "(none)";
      log(`Event: age=${ageText}, description="${descText}"`);

      if (!descEl || descText === "(none)" || descText.trim() === "") {
        recordIssue("First event has no description", "Event intro shown without any event description text", ["bug", "critical"]);
      }

      // Click "enter" to begin chat
      const enterBtn = await page.$("div.event-intro button.btn");
      if (enterBtn) {
        await enterBtn.click();
        log("Clicked 'enter' to begin chat");
      } else {
        recordIssue("No 'enter' button on event intro", "Cannot proceed to chat from event intro", ["bug", "critical"]);
      }
    } catch (err) {
      recordIssue("Event intro flow broken", err.message, ["bug", "critical"]);
    }

    // ── Step 5: Family Chat — respond to first event ──
    log("Step 5: Family chat (event 1)...");
    try {
      await page.waitForSelector("div.chat", { timeout: 10000 });
      log("Chat screen appeared");

      // Check message input is focused
      const inputEl = await page.$("form.message-input input");
      const inputDisabled = inputEl ? await inputEl.isDisabled() : true;
      log(`Chat input disabled: ${inputDisabled}`);

      // Check dots
      const dots = await page.$$("form.message-input .message-dot, .message-dots .message-dot");
      log(`Message dots count: ${dots.length}`);
      if (dots.length !== 12) {
        recordIssue("Incorrect message dot count", `Expected 12 dots, found ${dots.length}`, ["bug"]);
      }

      // Send 2 messages
      const messages = [
        "It's going to be okay, I'm here for you.",
        "You're very brave for talking about this."
      ];

      for (let i = 0; i < messages.length; i++) {
        log(`Sending message ${i + 1}: "${messages[i]}"`);
        const msgInput = await page.$("form.message-input input");
        if (!msgInput) {
          recordIssue("Chat input disappeared", "Message input not found in chat", ["bug"]);
          break;
        }

        await msgInput.fill(messages[i]);
        const sendBtn = await page.$("form.message-input button");
        const sendDisabled = sendBtn ? await sendBtn.isDisabled() : true;
        log(`Send button disabled: ${sendDisabled}`);

        if (sendBtn && !sendDisabled) {
          await sendBtn.click();
        } else {
          log("Attempting to send via form submit...");
          await msgInput.press("Enter");
        }

        // Wait for kid response to finish streaming
        log("Waiting for kid response...");
        try {
          // Wait for streaming to finish - the streaming indicator should disappear
          await page.waitForFunction(() => {
            const sendBtn = document.querySelector("form.message-input button");
            return !sendBtn?.disabled;
          }, { timeout: 30000 });
          log(`Message ${i + 1} response complete`);
        } catch {
          log("Kid response may have timed out or button never re-enabled");
        }

        // Check that a new child message appeared
        const kidMessages = await page.$$("div.message-kid");
        log(`Kid messages after response ${i + 1}: ${kidMessages.length}`);
      }

      // ── Step 6: End conversation ──
      log("Step 6: Ending conversation 1...");
      const endConvBtn = await page.$("button.btn.btn-secondary");
      if (endConvBtn) {
        const endDisabled = await endConvBtn.isDisabled();
        log(`End conversation button disabled: ${endDisabled}`);
        if (!endDisabled) {
          await endConvBtn.click();
          log("Clicked 'end conversation'");
        } else {
          recordIssue("End conversation button stays disabled", "Could not end conversation - button is disabled even with messages exchanged", ["bug"]);
        }
      } else {
        recordIssue("End conversation button missing", "No 'end conversation' button found in chat", ["bug"]);
      }
    } catch (err) {
      recordIssue("Family chat flow broken (event 1)", err.message, ["bug", "critical"]);
    }

    // ── Step 7: Processing ──
    log("Step 7: Processing screen...");
    try {
      await page.waitForSelector("div.processing-screen", { timeout: 15000 });
      log("Processing screen appeared");

      // Wait for debrief
      await page.waitForSelector("div.debrief-enhanced", { timeout: 60000 });
      log("Debrief screen appeared");

      // Check debrief text
      const debriefLine1 = await page.textContent("p.debrief-line-1");
      const debriefLine2 = await page.textContent("p.debrief-line-2");
      log(`Debrief: "${debriefLine1}" / "${debriefLine2}"`);

      // ── Step 8: Click "next event" ──
      log("Step 8: Moving to next event...");
      const nextEventBtn = await page.$("div.debrief-enhanced button.btn");
      if (nextEventBtn) {
        await nextEventBtn.click();
        log("Clicked 'next event'");
      } else {
        recordIssue("'next event' button missing", "Debrief screen has no 'next event' button", ["bug"]);
      }
    } catch (err) {
      recordIssue("Processing/debrief flow broken", err.message, ["bug"]);
    }

    // ── Step 9: Second Life Event Intro ──
    log("Step 9: Second life event intro...");
    try {
      await page.waitForSelector("div.event-intro", { timeout: 30000 });

      const isGenerating2 = await page.$("span.event-spinner");
      if (isGenerating2) {
        log("Event is generating, waiting...");
        await page.waitForSelector("span.event-spinner", { state: "detached", timeout: 60000 });
      }

      const ageEl2 = await page.$("p.age-marker");
      const descEl2 = await page.$("p.event-description");
      const ageText2 = ageEl2 ? await ageEl2.textContent() : "(none)";
      const descText2 = descEl2 ? await descEl2.textContent() : "(none)";
      log(`Event 2: age=${ageText2}, description="${descText2}"`);

      if (ageText2 === ageText) {
        recordIssue("Age did not change between events", `Both events show age: ${ageText2}`, ["bug"]);
      }

      // Click enter
      const enterBtn2 = await page.$("div.event-intro button.btn");
      if (enterBtn2) {
        await enterBtn2.click();
        log("Entered second event chat");
      }
    } catch (err) {
      recordIssue("Second event intro broken", err.message, ["bug"]);
    }

    // ── Step 10: Second event chat ──
    log("Step 10: Family chat (event 2)...");
    try {
      await page.waitForSelector("div.chat", { timeout: 10000 });

      // Send 2 messages
      const msgs2 = [
        "That's a great question! What do you think?",
        "Let's figure it out together."
      ];

      for (let i = 0; i < msgs2.length; i++) {
        log(`Sending event 2 message ${i + 1}: "${msgs2[i]}"`);
        const input2 = await page.$("form.message-input input");
        if (!input2) {
          recordIssue("Chat input gone in event 2", "Missing input during second event", ["bug"]);
          break;
        }
        await input2.fill(msgs2[i]);
        const sendBtn2 = await page.$("form.message-input button");
        if (sendBtn2 && !(await sendBtn2.isDisabled())) {
          await sendBtn2.click();
        } else {
          await input2.press("Enter");
        }

        try {
          await page.waitForFunction(() => {
            const btn = document.querySelector("form.message-input button");
            return !btn?.disabled;
          }, { timeout: 30000 });
        } catch {
          log("Timeout waiting for response");
        }
      }

      // End second conversation
      log("Ending conversation 2...");
      const endBtn2 = await page.$("button.btn.btn-secondary");
      if (endBtn2 && !(await endBtn2.isDisabled())) {
        await endBtn2.click();
        log("Ended conversation 2");
      }

      // Wait for debrief again
      await page.waitForSelector("div.debrief-enhanced", { timeout: 60000 });
      log("Debrief 2 appeared");

      // ── Step 11: End childhood -> Epilogue ──
      log("Step 11: Ending childhood -> epilogue...");
      const endChildhoodBtn = await page.$("div.debrief button.btn.btn-secondary");
      if (!endChildhoodBtn) {
        // Try alternate selector
        const altBtn = await page.$('button:has-text("end childhood")');
        if (altBtn) {
          await altBtn.click();
          log("Clicked end childhood (alt selector)");
        } else {
          recordIssue("End childhood -> epilogue button missing", "Could not find the button to end childhood", ["bug"]);
        }
      } else {
        await endChildhoodBtn.click();
        log("Clicked 'end childhood -> epilogue'");
      }
    } catch (err) {
      recordIssue("Second event chat or epilogue transition broken", err.message, ["bug"]);
    }

    // ── Step 12: Processing -> Epilogue ──
    log("Step 12: Waiting for epilogue...");
    try {
      await page.waitForSelector("div.endgame", { timeout: 60000 });
      log("Epilogue appeared");

      const epilogueLabel = await page.textContent("p.endgame-label");
      const epilogueParas = await page.$$("p.epilogue-para");
      log(`Epilogue label: "${epilogueLabel}", paragraphs: ${epilogueParas.length}`);

      if (epilogueParas.length === 0) {
        recordIssue("Empty epilogue", "No paragraphs in the epilogue", ["bug"]);
      }

      // Check continue button
      const continueBtn = await page.$("div.endgame-actions > button.btn");
      if (continueBtn) {
        log("Found 'continue' button on epilogue");
        await continueBtn.click();
        log("Clicked continue to report card");
      } else {
        recordIssue("No 'continue' button after epilogue", "Cannot proceed from epilogue to report card", ["bug"]);
      }
    } catch (err) {
      recordIssue("Epilogue flow broken", err.message, ["bug"]);
    }

    // ── Step 13: Report Card ──
    log("Step 13: Report card...");
    try {
      await page.waitForSelector("div.report-card", { timeout: 60000 });
      log("Report card appeared!");

      // Wait a moment for content to load
      await page.waitForTimeout(3000);

      const rcText = await page.textContent("div.report-card");
      log(`Report card content length: ${rcText?.length ?? 0} chars`);
      if (!rcText || rcText.trim().length < 50) {
        recordIssue("Report card nearly empty", `Content length: ${rcText?.length ?? 0}`, ["bug"]);
      } else {
        log(`Report card preview: "${rcText.slice(0, 200)}..."`);
      }
    } catch (err) {
      recordIssue("Report card never appeared", err.message, ["bug"]);
    }

  } catch (err) {
    recordIssue("Uncaught error in playtest", err.message, ["critical"]);
  }

  // ── Final: Collect results ──
  log("\n=== PLAYTEST SUMMARY ===");

  // Process console errors
  if (consoleErrors.length > 0) {
    recordIssue(
      "Console errors during playthrough",
      consoleErrors.map(e => `- ${e}`).join("\n"),
      ["bug", "frontend"]
    );
  }

  if (failedRequests.length > 0) {
    recordIssue(
      "Failed network requests during playthrough",
      failedRequests.map(r => `- ${r.url} (${r.failure})`).join("\n"),
      ["bug", "network"]
    );
  }

  const errorResponses = networkErrors.filter(e => e.status >= 500);
  if (errorResponses.length > 0) {
    recordIssue(
      "Server errors during playthrough",
      errorResponses.map(e => `- ${e.status} ${e.url}`).join("\n"),
      ["bug", "server"]
    );
  }

  log(`\nTotal issues found: ${issues.length}`);
  log("\nISSUES JSON:");
  console.log(JSON.stringify(issues, null, 2));

  await browser.close();
})();
