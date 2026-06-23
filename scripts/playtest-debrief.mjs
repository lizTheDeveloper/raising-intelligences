/**
 * Quick targeted test: verify the debrief "end childhood" button exists but is off-screen
 * due to double min-height: 80dvh layout conflict.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto("http://localhost:5173");
await page.waitForSelector(".mode-choice");
await page.click(".mode-choice .btn-secondary");
await page.waitForSelector("input.name-input");
await page.fill("input.name-input", "TestKid");
await page.click('[data-testid="btn-begin"]');
await page.waitForSelector(".guardian-screen");

// Quick-wait for event to start generating
await page.waitForSelector('[data-testid="btn-guardian-ready"]', { timeout: 120_000 });

// Click "not ready" to bypass animation
await page.click('[data-testid="btn-guardian-not-ready"]');
await page.waitForSelector(".guardian-not-ready-message", { timeout: 3000 });

// Now wait for and click "I'm ready" 
await page.click('[data-testid="btn-guardian-ready"]');

// Enter event
await page.waitForSelector('[data-testid="btn-enter-event"]', { timeout: 120_000 });
await page.click('[data-testid="btn-enter-event"]');

// Send a message (speed through chat)
await page.waitForSelector("form.message-input input:not([disabled])", { timeout: 120_000 });
await page.fill("form.message-input input", "Hello?");
await page.click('form.message-input button[type="submit"]');
await page.waitForSelector('form.message-input input:not([disabled])', { timeout: 120_000 });

// End chat
await page.click('[data-testid="btn-end-chat"]');
await page.waitForSelector(".processing-screen", { timeout: 10_000 });

// Wait for debrief
await page.waitForSelector(".debrief-enhanced", { timeout: 120_000 });
console.log("Debrief screen visible");

// Check for "end childhood" button
const epiBtn = await page.$('[data-testid="btn-epilogue"]');
if (epiBtn) {
  console.log("  'end childhood' button EXISTS in DOM");
  const isVisible = await epiBtn.isVisible();
  console.log(`  isVisible() = ${isVisible}`);
  const boundingBox = await epiBtn.boundingBox();
  console.log(`  boundingBox:`, boundingBox);
  
  // How far below viewport is it?
  const vph = await page.evaluate(() => window.innerHeight);
  if (boundingBox) {
    console.log(`  Viewport height: ${vph}px`);
    console.log(`  Button Y start: ${boundingBox.y}px`);
    console.log(`  Button is ${vph - boundingBox.y}px below the top of viewport`);
    if (boundingBox.y > vph) {
      console.log(`  *** BUTTON IS OFF-SCREEN BELOW FOLD BY ${(boundingBox.y - vph).toFixed(0)}px`);
    }
  }
  
  // Now check: the debrief-enhanced takes 80dvh, the debrief wrapper also takes 80dvh
  const debriefEnhancedHeight = await page.evaluate(`
    document.querySelector('.debrief-enhanced').getBoundingClientRect().height
  `);
  const debriefWrapperHeight = await page.evaluate(`
    document.querySelector('.debrief').getBoundingClientRect().height
  `);
  console.log(`  .debrief-enhanced height: ${debriefEnhancedHeight}px`);
  console.log(`  .debrief (wrapper) height: ${debriefWrapperHeight}px`);
  console.log(`  *** BOTH divs have min-height 80dvh — stacking causes off-screen layout`);
  
} else {
  console.log("  'end childhood' button NOT FOUND in DOM");
}

// Screenshot for reference
await page.screenshot({ path: "/Users/annhoward/src/raising_intelligences/playtest-debrief-debug.png", fullPage: true });
console.log("\nFull-page screenshot saved to playtest-debrief-debug.png");

await browser.close();
