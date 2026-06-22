/**
 * Generate lo-fi child portraits using OpenAI gpt-image-1.
 * Generates the youngest age first, then uses it as a visual reference
 * for subsequent ages so the same kid is recognizable growing up.
 *
 * Usage: OPENAI_API_KEY=sk-... node scripts/gen-portraits.mjs [gameId]
 *
 * gameId is optional — if provided, saves into portraits/{gameId}/
 * Otherwise saves into client/public/portraits/ as static fallbacks.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const GAME_ID = process.argv[2];
const OUT_DIR = GAME_ID
  ? join(__dir, "../server/portraits", GAME_ID)
  : join(__dir, "../client/public/portraits");

mkdirSync(OUT_DIR, { recursive: true });

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("OPENAI_API_KEY not set"); process.exit(1); }

const AGES = [
  { slug: "age-03", figure: "tiny round-headed toddler, maybe 3 years old," },
  { slug: "age-07", figure: "7-year-old child," },
  { slug: "age-12", figure: "12-year-old preteen," },
  { slug: "age-16", figure: "16-year-old teenager with slightly slumped posture," },
  { slug: "age-20", figure: "person in their mid-twenties," },
];

// A sample descriptor — in the game this is derived from the gameId
const HAIR = "dark brown wavy shoulder-length hair";
const CLOTHING = "soft grey hoodie";

function firstPrompt(figure) {
  return [
    `Lo-fi anime illustration of a ${figure} with ${HAIR},`,
    `wearing a ${CLOTHING}, seen from behind,`,
    `sitting at a wooden desk facing a softly glowing screen.`,
    `Warm amber and golden backlight fills the room.`,
    `Dark cozy bedroom, bookshelf in background, houseplant on windowsill,`,
    `rain outside a night window with soft reflections.`,
    `Muted warm palette, soft film grain, slightly desaturated,`,
    `gentle nostalgic mood, lo-fi music aesthetic.`,
    `Flat illustration style, clean lines, no text, no watermark. Square 1:1.`,
  ].join(" ");
}

function agingPrompt(figure) {
  return [
    `The same character from the reference image, now ${figure}`,
    `Seen from behind at the same cozy desk, same ${HAIR}, same ${CLOTHING}.`,
    `They have grown — body proportions have changed with age — but the setting is the same.`,
    `Dark cozy bedroom, warm amber desk lamp glow, rain on window, bookshelf behind.`,
    `Lo-fi anime illustration style, muted warm palette, soft film grain. Square 1:1. No text, no watermark.`,
  ].join(" ");
}

async function generateFirst(figure, outPath) {
  console.log(`Generating first portrait: ${figure}…`);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: firstPrompt(figure),
      n: 1,
      size: "1024x1024",
      output_format: "png",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image in response");
  const buf = Buffer.from(b64, "base64");
  writeFileSync(outPath, buf);
  console.log(`  ✓ Saved (${Math.round(buf.length / 1024)}KB)`);
  return outPath;
}

async function generateWithReference(figure, outPath, refPath) {
  console.log(`Generating with reference: ${figure}…`);
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", agingPrompt(figure));
  form.append("n", "1");
  form.append("size", "1024x1024");
  const refBuf = readFileSync(refPath);
  form.append("image", new Blob([refBuf], { type: "image/png" }), "reference.png");

  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}` },
    body: form,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image in response");
  const buf = Buffer.from(b64, "base64");
  writeFileSync(outPath, buf);
  console.log(`  ✓ Saved (${Math.round(buf.length / 1024)}KB)`);
}

// --- main: generate serially, each age referencing the previous ---
// age-03 → age-07 → age-12 → age-16 → age-20
let prevPath = null;

for (const { slug, figure } of AGES) {
  const outPath = join(OUT_DIR, `${slug}.png`);

  if (existsSync(outPath)) {
    console.log(`  (${slug}.png already exists, skipping)`);
    prevPath = outPath;
    continue;
  }

  try {
    if (!prevPath) {
      await generateFirst(figure, outPath);
    } else {
      await generateWithReference(figure, outPath, prevPath);
    }
    prevPath = outPath;
  } catch (e) {
    console.error(`  ✗ ${slug}: ${e.message}`);
    // keep prevPath — next age still references last successful portrait
  }
}

console.log(`\nDone. Portraits in: ${OUT_DIR}`);
