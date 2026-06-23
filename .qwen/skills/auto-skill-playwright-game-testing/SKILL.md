---
name: playwright-game-testing
description: Systematic approach to playtesting browser-based games and complex UI flows using Playwright
source: auto-skill
extracted_at: '2026-06-23T07:13:34.768Z'
---

# Playwright-Based Game/UI Playtesting

When asked to playtest a browser game or complex interactive application, follow this systematic approach.

## Phase 1: Explore the Codebase

Before writing any tests, understand the complete user flow:

```bash
# Find the main app component and routing
grep -r "createBrowserRouter\|Route\|<App" client/src/ --include="*.tsx"

# Find state management and phase/screen transitions
grep -r "useState.*phase\|setPhase" client/src/hooks/ --include="*.ts"

# Find form submissions and user interactions
grep -r "onSubmit\|handleClick\|onClick" client/src/components/ --include="*.tsx"

# Find API endpoints
grep -r "fetch.*api\|axios\|endpoint" client/src/ --include="*.ts"
```

Document the complete flow:
- What screens/phases exist and their order
- What buttons/inputs are on each screen (get CSS selectors)
- What API calls are made and what responses are expected
- What indicates "success" or "completion" for each step

## Phase 2: Write Comprehensive Playtest Script

Create a single script that walks through the entire user journey:

```javascript
import { chromium } from "playwright";

async function playtest() {
  const browser = await chromium.launch({ headless: false }); // headless: false for debugging
  const page = await browser.newPage();
  
  const issues = [];
  
  // Track console errors and network failures
  page.on("console", msg => {
    if (msg.type() === "error") {
      issues.push({ type: "console-error", message: msg.text() });
    }
  });
  
  page.on("requestfailed", req => {
    issues.push({ type: "network-error", url: req.url() });
  });
  
  try {
    // Step 1: Navigate and verify initial state
    await page.goto("http://localhost:5173");
    await page.waitForSelector(".start-screen");
    
    // Step 2: Interact with forms
    await page.fill("input[name='name']", "TestUser");
    await page.click("button[type='submit']");
    
    // Step 3: Verify transitions
    await page.waitForSelector(".game-screen", { timeout: 5000 });
    
    // Step 4: Test async flows (see Phase 3 below)
    
  } catch (err) {
    issues.push({ type: "playtest-error", message: err.message, stack: err.stack });
  }
  
  await browser.close();
  return issues;
}
```

## Phase 3: Handle Async/Streaming Responses

Many modern apps use SSE or WebSocket for real-time updates. These don't complete in traditional Playwright assertions.

**Pattern**: Monitor UI state changes to detect completion:

```javascript
// For SSE chat responses - wait for send button to re-enable
await page.click("button#send");
await page.waitForFunction(() => {
  const btn = document.querySelector("button#send");
  return btn && !btn.disabled;
}, { timeout: 10000 });

// For loading states - wait for spinner to disappear
await page.waitForSelector(".spinner", { state: "hidden", timeout: 30000 });

// For dynamic content - wait for text to appear
await page.waitForFunction(() => {
  const el = document.querySelector(".response-text");
  return el && el.textContent.trim().length > 0;
});
```

## Phase 4: Diagnose Hangs Systematically

When a test hangs on an async operation (button stays disabled, content never appears), isolate the cause:

```javascript
// Test 1: Try the API directly (bypasses the UI)
const directResponse = await fetch("http://localhost:3000/api/endpoint", {
  method: "POST",
  body: JSON.stringify({ test: true })
});
console.log("Direct API works:", directResponse.ok);

// Test 2: Try from page context (tests browser → server path)
const pageContextResult = await page.evaluate(async () => {
  const res = await fetch("/api/endpoint", {
    method: "POST",
    body: JSON.stringify({ test: true })
  });
  return { status: res.status, ok: res.ok };
});
console.log("Page context works:", pageContextResult.ok);

// Test 3: Compare - if direct works but page context doesn't, it's the proxy
if (directResponse.ok && !pageContextResult.ok) {
  console.log("ISSUE: Dev server proxy is breaking the request");
  // Common causes:
  // - Vite proxy buffering SSE responses
  // - CORS issues
  // - Missing headers
}
```

## Phase 5: Document Issues Structurally

For each issue found, document:

```javascript
issues.push({
  title: "Clear, specific title",
  description: "What happened and why it's a problem",
  steps: "1. Step one\n2. Step two\n3. Step three",
  expected: "What should have happened",
  actual: "What actually happened",
  severity: "critical|high|medium|low",
  component: "Which part of the app",
  screenshot: "path/to/screenshot.png" // if applicable
});
```

## Phase 6: Diagnose Off-Screen / Layout Issues

When a button or element exists in the DOM but isn't visible or reachable interactively, suspect a layout bug:

```javascript
const btn = await page.$('[data-testid="target-button"]');
if (btn) {
  const isVisible = await btn.isVisible(); // true if element has non-zero bounding box
  const box = await btn.boundingBox();     // { x, y, width, height } or null

  if (isVisible && box) {
    const vph = await page.evaluate(() => window.innerHeight);
    if (box.y > vph || box.y + box.height < 0) {
      console.log(`OFF-SCREEN: button ${box.y > vph ? 'below' : 'above'} fold by ${(Math.abs(box.y > vph ? box.y - vph : -box.y)).toFixed(0)}px`);
    }
  }
}
```

**Common causes:**
- Two sibling containers both with `min-height: 80dvh` or `min-height: 100vh` stacking vertically — each takes the full viewport, pushing the second's centered content below the fold
- `position: fixed` or `position: absolute` elements that overlap and hide interactive elements beneath them
- `overflow: hidden` on a parent cutting off children
- CSS `text-transform: lowercase`/`uppercase` making labels appear wrong even though content is correct in state

**Verify with full-page screenshots:**
```javascript
await page.screenshot({ path: "debug.png", fullPage: true });
```
This captures everything including below-the-fold content. Compare with a normal screenshot (`fullPage` defaults to false) to confirm something is off-screen.

## Phase 7: Targeted Diagnostic Scripts

After the comprehensive playtest surfaces an issue, write a focused script to isolate it. Don't re-run the full playtest:

```javascript
// Targeted script: reproduce exactly the failing state and probe it
// Skip straight to the phase of interest, take minimal actions, then inspect.
await page.goto("http://localhost:5173");
// ... navigate fast to the target phase using "not ready" bypasses etc. ...

// Then diagnose:
const height1 = await page.evaluate(`document.querySelector('.container-a').getBoundingClientRect().height`);
const height2 = await page.evaluate(`document.querySelector('.container-b').getBoundingClientRect().height`);
console.log(`container-a: ${height1}px, container-b: ${height2}px`);
// → both are 576px (80dvh) confirming the stacking hypothesis
```

## Phase 8: Visual Regression & Content Verification Review

After each screen transition, take a screenshot for visual inspection. Pay attention to:

```javascript
// Screenshot at every phase for visual review
await page.screenshot({ path: `playtest-${phaseName}.png` });
```

**What to check in screenshots:**
- **Content rendering** — is generated text (epilogue, report card) actually present and legible?
- **Case preservation** — CSS `text-transform` can override user-provided capitalization (e.g., child's name "Aria" displays as "aria")
- **Whitespace / empty space** — large blank areas may indicate missing content or layout bugs
- **Button visibility** — not all buttons visible on a screen means potential layout issues
- **Portrait / media loading** — silhouette SVG shown instead of generated portrait image indicates loading failure or timeout

## Key Lessons

1. **Explore before coding** - Understanding the full flow prevents writing tests for non-existent features
2. **Get CSS selectors from the source** - More reliable than guessing selectors from rendered HTML
3. **Monitor state, not just DOM** - Button disabled state, loading flags, streaming flags are more reliable than waiting for specific text
4. **Isolate proxy issues** - If API works directly but hangs in browser, it's almost always the dev server proxy (Vite, webpack-dev-server, etc.)
5. **Use `page.evaluate()` for complex async** - When Playwright's page methods can't handle it, drop down to browser context
6. **Track everything** - Console errors, network failures, and screenshot failures separately from UI issues
7. **Off-screen ≠ missing** - A button that exists in `page.$()` but isn't visually reachable is often an off-screen layout bug (stacked `min-height`, overlapping fixed elements). Use `boundingBox()` + full-page screenshots.
8. **CSS text-transform hides case bugs** - If user-provided names display in lowercase when they shouldn't, check for `text-transform: lowercase` in CSS before blaming the data layer
9. **Component source + CSS audit for layout** - When a visual bug is found, read the parent component's JSX to see which containers wrap each section. Two sibling divs each with `min-height: 80dvh` is a common culprit for below-the-fold content.
10. **Component AbortController cleanup can mask issues** - React `useEffect` cleanup that aborts in-flight requests produces `ERR_ABORTED` noise. This is usually harmless to users but obscures real network failures in console; consider filtering these out when collecting errors.
