# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: playtest.spec.ts >> Full Raising Intelligences Solo Game Playtest
- Location: playtest.spec.ts:5:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.event-intro button:has-text("enter")')
Expected: visible
Timeout: 45000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 45000ms
  - waiting for locator('.event-intro button:has-text("enter")')

```

```yaml
- paragraph: generating next event...
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import * as fs from 'fs';
  3   | import * as path from 'path';
  4   | 
  5   | test('Full Raising Intelligences Solo Game Playtest', async ({ page }) => {
  6   |   // Increase test timeout since we are making LLM calls
  7   |   test.setTimeout(120000);
  8   | 
  9   |   const consoleErrors: string[] = [];
  10  |   const pageErrors: any[] = [];
  11  |   const networkFailures: string[] = [];
  12  |   const allConsoleLogs: string[] = [];
  13  |   const allRequests: any[] = [];
  14  | 
  15  |   // Capture all console logs
  16  |   page.on('console', (msg) => {
  17  |     allConsoleLogs.push(`[${msg.type().toUpperCase()}] ${msg.text()}`);
  18  |     if (msg.type() === 'error') {
  19  |       consoleErrors.push(`[Console Error] ${msg.text()}`);
  20  |     }
  21  |   });
  22  | 
  23  |   // Capture page errors (unhandled exceptions)
  24  |   page.on('pageerror', (err) => {
  25  |     pageErrors.push({
  26  |       message: err.message,
  27  |       stack: err.stack,
  28  |     });
  29  |   });
  30  | 
  31  |   // Capture all network requests
  32  |   page.on('request', (req) => {
  33  |     allRequests.push({
  34  |       method: req.method(),
  35  |       url: req.url(),
  36  |       postData: req.postData(),
  37  |     });
  38  |   });
  39  | 
  40  |   // Capture failed network requests
  41  |   page.on('requestfailed', (request) => {
  42  |     networkFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  43  |   });
  44  | 
  45  |   try {
  46  |     console.log('Navigating to game...');
  47  |     await page.goto('http://localhost:5173');
  48  | 
  49  |     // Verify the landing page is loaded
  50  |     await expect(page.locator('h1')).toHaveText('raising intelligences');
  51  |     await page.screenshot({ path: 'playtest-screenshots/1_landing_page.png' });
  52  | 
  53  |     // Click on "play solo"
  54  |     console.log('Clicking "play solo"...');
  55  |     const playSoloBtn = page.locator('button:has-text("play solo")');
  56  |     await expect(playSoloBtn).toBeVisible();
  57  |     await playSoloBtn.click();
  58  | 
  59  |     // We should be in the "name your child" screen
  60  |     console.log('Entering child name...');
  61  |     await expect(page.locator('p:has-text("name your child")')).toBeVisible();
  62  |     const nameInput = page.locator('.name-input');
  63  |     await expect(nameInput).toBeVisible();
  64  |     await nameInput.fill('Alex');
  65  | 
  66  |     // Take screenshot of lobby start screen
  67  |     await page.screenshot({ path: 'playtest-screenshots/2_name_input.png' });
  68  | 
  69  |     // Click "begin"
  70  |     console.log('Clicking "begin"...');
  71  |     const beginBtn = page.locator('button:has-text("begin")');
  72  |     await expect(beginBtn).toBeEnabled();
  73  |     await beginBtn.click();
  74  | 
  75  |     // Step 1: Initial event intro (currentEvent is null)
  76  |     console.log('Waiting for initial EventIntro screen...');
  77  |     const initialBeginBtn = page.locator('.event-intro button:has-text("begin")');
  78  |     await expect(initialBeginBtn).toBeVisible({ timeout: 15000 });
  79  |     await page.screenshot({ path: 'playtest-screenshots/3a_initial_event_intro.png' });
  80  | 
  81  |     console.log('Clicking "begin" to generate Event 1...');
  82  |     await initialBeginBtn.click();
  83  | 
  84  |     // Step 2: Generating event (loading) and then Event loaded (enter button visible)
  85  |     console.log('Waiting for Event 1 description to load...');
  86  |     const enterBtn = page.locator('.event-intro button:has-text("enter")');
> 87  |     await expect(enterBtn).toBeVisible({ timeout: 45000 });
      |                            ^ Error: expect(locator).toBeVisible() failed
  88  | 
  89  |     const event1Description = await page.locator('.event-description').textContent();
  90  |     console.log(`Event 1 Description: ${event1Description}`);
  91  |     await page.screenshot({ path: 'playtest-screenshots/3b_event1_loaded.png' });
  92  | 
  93  |     // Click "enter" to go to Chat
  94  |     console.log('Entering chat for Event 1...');
  95  |     await enterBtn.click();
  96  | 
  97  |     // Step 3: Phase 1 Chat: Message 1
  98  |     console.log('Sending first message to Alex...');
  99  |     const chatInput = page.locator('.message-input input[type="text"]');
  100 |     await expect(chatInput).toBeVisible();
  101 |     await chatInput.fill('Hi Alex! We are so excited to support you as you grow up.');
  102 |     
  103 |     const sendBtn = page.locator('.message-input button[type="submit"]');
  104 |     await expect(sendBtn).toBeEnabled();
  105 |     await sendBtn.click();
  106 | 
  107 |     // Wait for LLM streaming response to start and finish
  108 |     console.log('Waiting for Alex to respond...');
  109 |     await page.waitForTimeout(2000); // Wait for streaming to initiate
  110 |     await expect(sendBtn).toBeEnabled({ timeout: 45000 });
  111 | 
  112 |     await page.screenshot({ path: 'playtest-screenshots/4_event1_chat_reply1.png' });
  113 | 
  114 |     // Phase 1 Chat: Message 2
  115 |     console.log('Sending second message to Alex...');
  116 |     await chatInput.fill('We hope we can teach you how to be curious and kind.');
  117 |     await sendBtn.click();
  118 | 
  119 |     console.log('Waiting for second response...');
  120 |     await page.waitForTimeout(2000);
  121 |     await expect(sendBtn).toBeEnabled({ timeout: 45000 });
  122 | 
  123 |     await page.screenshot({ path: 'playtest-screenshots/5_event1_chat_reply2.png' });
  124 | 
  125 |     // End conversation
  126 |     console.log('Ending conversation 1...');
  127 |     const endConvBtn = page.locator('button:has-text("end conversation")');
  128 |     await expect(endConvBtn).toBeVisible();
  129 |     await endConvBtn.click();
  130 | 
  131 |     // Should transition to Debrief screen
  132 |     console.log('Waiting for Debrief screen...');
  133 |     const nextEventBtn = page.locator('button:has-text("next event")');
  134 |     await expect(nextEventBtn).toBeVisible({ timeout: 30000 });
  135 |     await page.screenshot({ path: 'playtest-screenshots/6_event1_debrief.png' });
  136 | 
  137 |     // Click "next event"
  138 |     console.log('Proceeding to Event 2...');
  139 |     await nextEventBtn.click();
  140 | 
  141 |     // Phase 2: Initial Event 2 Intro (currentEvent is null)
  142 |     console.log('Waiting for second EventIntro initial screen...');
  143 |     await expect(initialBeginBtn).toBeVisible({ timeout: 15000 });
  144 |     await page.screenshot({ path: 'playtest-screenshots/7a_second_event_intro_initial.png' });
  145 | 
  146 |     console.log('Clicking "begin" to generate Event 2...');
  147 |     await initialBeginBtn.click();
  148 | 
  149 |     // Phase 2: Event 2 Loaded
  150 |     console.log('Waiting for Event 2 description to load...');
  151 |     await expect(enterBtn).toBeVisible({ timeout: 45000 });
  152 | 
  153 |     const event2Description = await page.locator('.event-description').textContent();
  154 |     console.log(`Event 2 Description: ${event2Description}`);
  155 |     await page.screenshot({ path: 'playtest-screenshots/7b_event2_loaded.png' });
  156 | 
  157 |     // Click "enter" to go to Chat
  158 |     console.log('Entering chat for Event 2...');
  159 |     await enterBtn.click();
  160 | 
  161 |     // Phase 2 Chat: Message 1
  162 |     console.log('Sending message for Event 2...');
  163 |     await expect(chatInput).toBeVisible();
  164 |     await chatInput.fill('Let us tackle this situation step-by-step and make an informed choice.');
  165 |     await sendBtn.click();
  166 | 
  167 |     console.log('Waiting for Alex to respond...');
  168 |     await page.waitForTimeout(2000);
  169 |     await expect(sendBtn).toBeEnabled({ timeout: 45000 });
  170 | 
  171 |     await page.screenshot({ path: 'playtest-screenshots/8_event2_chat_reply1.png' });
  172 | 
  173 |     // End conversation
  174 |     console.log('Ending conversation 2...');
  175 |     await expect(endConvBtn).toBeVisible();
  176 |     await endConvBtn.click();
  177 | 
  178 |     // Debrief screen 2: Click "end childhood -> epilogue"
  179 |     console.log('Waiting for Debrief screen 2...');
  180 |     const endChildhoodBtn = page.locator('button:has-text("end childhood")');
  181 |     await expect(endChildhoodBtn).toBeVisible({ timeout: 30000 });
  182 |     await page.screenshot({ path: 'playtest-screenshots/9_event2_debrief.png' });
  183 | 
  184 |     console.log('Clicking "end childhood -> epilogue"...');
  185 |     await endChildhoodBtn.click();
  186 | 
  187 |     // Wait for Epilogue
```