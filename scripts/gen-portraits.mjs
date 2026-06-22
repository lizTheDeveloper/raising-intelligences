/**
 * Generate lo-fi child portraits for several ages using OpenRouter + Gemini Image.
 * Saves PNGs to client/public/portraits/
 * Usage: node scripts/gen-portraits.mjs
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, "../client/public/portraits");
mkdirSync(OUT_DIR, { recursive: true });

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }

const AGES = [
  { age: 3,  label: "toddler",   slug: "age-03" },
  { age: 7,  label: "child",     slug: "age-07" },
  { age: 12, label: "preteen",   slug: "age-12" },
  { age: 16, label: "teen",      slug: "age-16" },
];

function prompt(age, label) {
  const sizeAdjectives = {
    3:  "tiny, round-headed toddler",
    7:  "small child",
    12: "preteen",
    16: "teenager with slightly slumped posture",
  };
  const figure = sizeAdjectives[age] ?? "child";
  return [
    `Lo-fi anime illustration of a ${figure}, seen from behind,`,
    `sitting at a wooden desk facing a softly glowing screen.`,
    `Warm amber and golden backlight fills the room.`,
    `Dark cozy bedroom, bookshelf in background, houseplant on windowsill,`,
    `rain outside a night window with soft reflections.`,
    `Muted warm palette, soft film grain, slightly desaturated,`,
    `gentle nostalgic mood, lo-fi music aesthetic.`,
    `Flat illustration style, clean lines, no text, no watermark.`,
    `Square composition 1:1.`,
  ].join(" ");
}

async function generate(entry) {
  const { age, label, slug } = entry;
  console.log(`Generating age ${age} (${label})…`);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: prompt(age, label) }],
    }),
  });

  const data = await res.json();

  if (data.error) {
    console.error(`  ✗ Error for age ${age}:`, data.error.message ?? data.error);
    return null;
  }

  const images = data.choices?.[0]?.message?.images;
  if (!images?.length) {
    console.error(`  ✗ No images in response for age ${age}`);
    console.error("  Response keys:", Object.keys(data.choices?.[0]?.message ?? {}));
    return null;
  }

  const url = images[0].image_url.url;
  const b64 = url.replace(/^data:image\/\w+;base64,/, "");
  const outPath = join(OUT_DIR, `${slug}.png`);
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`  ✓ Saved ${slug}.png (${Math.round(b64.length * 3/4 / 1024)}KB)`);
  return outPath;
}

// Generate all ages (sequentially to be polite to the API)
const results = [];
for (const entry of AGES) {
  const path = await generate(entry);
  results.push({ ...entry, path });
  // Small pause between requests
  await new Promise(r => setTimeout(r, 1500));
}

console.log("\nDone. Results:");
results.forEach(r => console.log(`  age ${r.age}: ${r.path ?? "FAILED"}`));

// Write a quick HTML viewer
const viewerPath = join(OUT_DIR, "index.html");
writeFileSync(viewerPath, `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { background: #0a0a0a; font-family: 'IBM Plex Mono', monospace; color: #888; display: flex; gap: 24px; padding: 40px; flex-wrap: wrap; }
  figure { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  img { width: 220px; height: 220px; object-fit: cover; display: block; }
  figcaption { font-size: 11px; letter-spacing: 3px; }
</style>
</head>
<body>
${results.filter(r => r.path).map(r => `
  <figure>
    <img src="${r.slug}.png" alt="age ${r.age}">
    <figcaption>— age ${r.age} —</figcaption>
  </figure>`).join('')}
</body>
</html>`);
console.log(`\nViewer: ${viewerPath}`);
