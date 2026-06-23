import { chromium } from "playwright";

const issues = [];
function record(title, body, labels = []) {
  issues.push({ title, body, labels });
  console.log(`[ISSUE] ${title}`);
}
function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  // Create a game via API
  async function createGame(name) {
    const res = await fetch("http://localhost:3000/api/game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childName: name }),
    });
    return (await res.json()).gameId;
  }

  async function nextEvent(gid) {
    return fetch(`http://localhost:3000/api/game/${gid}/next-event`, { method: "POST" });
  }

  async function testSSE(url, sender, content, timeoutMs) {
    const start = Date.now();
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, content }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return { error: `HTTP ${res.status}`, elapsed: Date.now() - start };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunks = 0;
      let doneData = null;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "chunk") chunks++;
            if (data.type === "done") doneData = data;
          } catch {}
        }
      }
      return { chunks, done: !!doneData, elapsed: Date.now() - start };
    } catch (err) {
      return { error: err.message, elapsed: Date.now() - start };
    } finally {
      clearTimeout(tid);
    }
  }

  // Test 1: Direct connection (localhost:3000)
  log("Test 1: SSE via direct server connection (port 3000)...");
  const game1 = await createGame("Direct");
  await nextEvent(game1);
  const direct = await testSSE(
    `http://localhost:3000/api/game/${game1}/message`,
    "parent1", "hello", 30000
  );
  log(`Direct: ${JSON.stringify(direct)}`);

  // Test 2: Via Vite proxy (localhost:5173) — use fetch from page context
  log("Test 2: SSE via Vite dev server proxy (port 5173)...");
  const game2 = await createGame("Proxy");
  await nextEvent(game2);

  // Need to navigate to 5173 first for relative fetch to work
  const page = await browser.newPage();
  await page.goto("http://localhost:5173", { waitUntil: "networkidle", timeout: 10000 });

  const proxy = await page.evaluate(async (gid) => {
    const start = Date.now();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`/api/game/${gid}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "parent1", content: "hello" }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return { error: `HTTP ${res.status}`, elapsed: Date.now() - start };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let chunks = 0;
      let doneData = null;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "chunk") chunks++;
            if (data.type === "done") doneData = data;
          } catch {}
        }
      }
      return { chunks, done: !!doneData, elapsed: Date.now() - start };
    } catch (err) {
      return { error: err.message, elapsed: Date.now() - start };
    }
  }, game2);
  log(`Proxy: ${JSON.stringify(proxy)}`);

  // Compare
  if (direct.done && !proxy.done) {
    record("Vite proxy breaks SSE streaming",
      `Direct: ${direct.chunks} chunks in ${direct.elapsed}ms. Proxy: ${proxy.chunks} chunks, done=${proxy.done} (${proxy.error || 'hung'}). The http-proxy likely buffers SSE chunks instead of flushing them.`,
      ["bug", "critical", "sse", "proxy"]);
  } else if (direct.done && proxy.done) {
    log("✓ Both work — direct and proxy SSE both stream correctly");
  } else if (!direct.done) {
    record("SSE broken on direct connection too", JSON.stringify(direct), ["bug", "critical"]);
  }

  await browser.close();
  console.log("\nFINAL_ISSUES_JSON:");
  console.log(JSON.stringify(issues, null, 2));
})();
