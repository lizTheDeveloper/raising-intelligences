const { chromium } = require('playwright');

async function run() {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();

  // Capture console errors and logs
  page.on('pageerror', (err) => {
    console.error('[BROWSER ERROR]', err.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error('[BROWSER CONSOLE ERROR]', msg.text());
    } else {
      console.log('[BROWSER LOG]', msg.text());
    }
  });

  // Capture network responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/')) {
      try {
        console.log(`[NETWORK RESPONSE] ${response.status()} ${url}`);
        const text = await response.text();
        console.log(`[NETWORK RESPONSE BODY]`, text.substring(0, 300) + (text.length > 300 ? "..." : ""));
      } catch (e) {}
    }
  });

  try {
    console.log("Navigating to game homepage...");
    await page.goto('http://localhost:5173/');

    console.log("Clicking 'play solo'...");
    await page.click('button:has-text("play solo")');

    console.log("Filling child name...");
    await page.fill('input', 'Oliver');

    console.log("Clicking first 'begin'...");
    await page.click('button:has-text("begin")');

    console.log("Waiting for second 'begin'...");
    await page.waitForTimeout(2000);
    const beginButton = page.locator('button:has-text("begin")');
    await beginButton.waitFor({ state: 'visible', timeout: 5000 });
    await beginButton.click();

    console.log("Waiting for 'enter' button to be visible (timeout 60s)...");
    const enterButton = page.locator('button:has-text("enter")');
    await enterButton.waitFor({ state: 'visible', timeout: 60000 });
    
    // Read and log the generated event description before entering
    const descText = await page.innerText('.event-description');
    console.log("\n--- GENERATED EVENT ---\n", descText, "\n-----------------------\n");

    await enterButton.click();

    console.log("Waiting for event chat to load...");
    await page.waitForSelector('.chat', { timeout: 15000 });

    console.log("Chat loaded! Sending first message...");
    await page.fill('.message-input input[type="text"]', "Oliver, don't worry. I'm right here with you. Let's take a deep breath together.");
    await page.click('.message-input button[type="submit"]');

    console.log("Waiting for Oliver's response stream...");
    await page.waitForTimeout(8000); // Allow time for stream to complete

    console.log("Sending second message...");
    await page.fill('.message-input input[type="text"]', "Preschool can be scary but it's also fun! We'll build a giant block tower.");
    await page.click('.message-input button[type="submit"]');

    console.log("Waiting for Oliver's response stream...");
    await page.waitForTimeout(8000);

    console.log("Ending conversation...");
    await page.click('button:has-text("end conversation")');

    console.log("Waiting for debrief screen (timeout 60s)...");
    await page.waitForSelector('button:has-text("end childhood")', { timeout: 60000 });

    console.log("Clicking 'end childhood -> epilogue'...");
    await page.click('button:has-text("end childhood")');

    console.log("Waiting for epilogue screen (timeout 90s)...");
    await page.waitForSelector('.endgame', { timeout: 90000 });
    
    const epilogueText = await page.innerText('.endgame');
    console.log("\n--- EPILOGUE ---\n", epilogueText, "\n----------------\n");

    console.log("Clicking 'continue' to reach report card...");
    await page.click('button:has-text("continue")');

    console.log("Waiting for report card (timeout 150s)...");
    await page.waitForSelector('.report-card', { timeout: 150000 });

    const reportCardText = await page.innerText('.report-card');
    console.log("\n--- REPORT CARD ---\n", reportCardText, "\n-------------------\n");

    console.log("Playtest run successful! Closing browser.");
    await browser.close();
  } catch (err) {
    console.error("Playtest execution failed!");
    await page.screenshot({ path: 'timeout.png' });
    console.log("Screenshot saved to timeout.png");
    try {
      console.log("Body HTML content:\n", await page.evaluate(() => document.body.innerHTML));
    } catch (e) {}
    await browser.close();
    throw err;
  }
}

run().catch(err => {
  console.error("Fatal playtest error:", err);
  process.exit(1);
});
