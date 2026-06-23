/**
 * Generate a pool of lo-fi intro images using gpt-image-2 via OpenRouter.
 * Creates 6 variants each for ages 0, 1, and 2. The client picks
 * a random variant per playthrough so "first steps" feels different.
 *
 * The same generic child is depicted across all images — consistent hair,
 * build, and clothing — seen from behind, growing from newborn to toddler.
 *
 * Uses gpt-5-image-mini via OpenRouter chat completions API.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/generate-intro-images.mjs
 *
 * Images are saved to client/public/portraits/intro/age-{N}-{V}.jpg
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, "../client/public/portraits/intro");
mkdirSync(OUT_DIR, { recursive: true });

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("OPENROUTER_API_KEY required");
  process.exit(1);
}

const VARIANTS_PER_AGE = 6;

// Fixed character look so every image is recognizably the same child.
const KID = "dark brown fluffy hair, wearing a soft cream onesie";
const TODDLER_KID = "dark brown fluffy hair, wearing a dusty blue oversized sweater";

const STYLE = [
  "Lo-fi anime illustration style, flat illustration, clean lines.",
  "Muted warm palette, soft film grain, slightly desaturated,",
  "gentle nostalgic mood, lo-fi music aesthetic.",
  "Child seen from behind, no face visible, no text, no watermark.",
  "Square composition 1:1.",
].join(" ");

const AGE_PROMPTS = [
  {
    age: 0,
    scenes: [
      `Tiny newborn with ${KID}, bundled in a blanket in a wooden crib, seen from above. Dark cozy nursery, warm amber nightlight glow, soft mobile hanging above, rain on window.`,
      `Tiny newborn with ${KID}, sleeping in a bassinet, seen from above. Dark bedroom, warm amber lamplight on nightstand, curtains drawn, nighttime.`,
      `Tiny newborn with ${KID}, held against a parent's shoulder, seen from behind the parent. Dark living room at night, warm lamp glow, rain on window.`,
      `Tiny newborn with ${KID}, curled up in a nest of blankets on a bed, seen from above. Cozy dark room, warm amber bedside lamp, night outside window.`,
      `Tiny newborn with ${KID}, cradled in arms, seen from behind the holder, tiny head resting on shoulder. Dark hallway, warm light spilling from nursery doorway.`,
      `Tiny newborn with ${KID}, sleeping in a soft blanket on a couch, seen from above. Dark living room, warm amber lamp, rain streaking the window at night.`,
    ],
  },
  {
    age: 1,
    scenes: [
      `Baby with ${KID}, crawling on a wooden floor, seen from behind. Dark cozy bedroom, warm amber lamplight, rain on window at night, bookshelf in background.`,
      `Baby with ${KID}, sitting on a rug reaching for a stuffed animal, seen from behind. Dark living room, warm lamp glow, houseplant silhouette, rain on window.`,
      `Baby with ${KID}, pulling themselves up on a coffee table, seen from behind. Dark cozy room, warm amber light, nighttime.`,
      `Baby with ${KID}, crawling toward a softly glowing screen on the floor, seen from behind. Dark bedroom, warm amber desk lamp, bookshelves, rain outside.`,
      `Baby with ${KID}, sitting looking out a rain-streaked window, seen from behind, small silhouette against the glass. Dark room, warm pendant light above.`,
      `Baby with ${KID}, reaching up from the floor toward a bookshelf, seen from behind. Dark cozy room, warm lamplight, night.`,
    ],
  },
  {
    age: 2,
    scenes: [
      `Tiny toddler with ${TODDLER_KID}, taking first steps in a hallway, arms slightly out for balance, seen from behind. Dark cozy home, warm amber lamplight, rain on window at night.`,
      `Small toddler with ${TODDLER_KID}, standing at a window watching rain, hands pressed against glass, seen from behind. Dark bedroom, warm light behind them, night.`,
      `Toddler with ${TODDLER_KID}, walking unsteadily toward an open door with warm light spilling through, seen from behind. Dark hallway, cozy home.`,
      `Toddler with ${TODDLER_KID}, reaching for a doorknob on tiptoes, seen from behind. Dark cozy home, warm lamplight, rain outside window.`,
      `Small toddler with ${TODDLER_KID}, toddling across a wooden floor carrying a stuffed animal, seen from behind. Dark living room, warm amber lamp, rain on windows.`,
      `Toddler with ${TODDLER_KID}, standing at the bottom of stairs looking up, seen from behind. Dark cozy home, warm light from above, nighttime.`,
    ],
  },
];

async function generate(prompt) {
  const fullPrompt = `${prompt} ${STYLE}`;
  console.log(`    Prompt: ${fullPrompt.slice(0, 80)}...`);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
    body: JSON.stringify({
      model: "openai/gpt-5-image-mini",
      messages: [{ role: "user", content: `Generate an image: ${fullPrompt}` }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const img = data.choices?.[0]?.message?.images?.[0];
  if (!img?.image_url?.url) throw new Error("No image in response");
  const b64 = img.image_url.url.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(b64, "base64");
}

console.log(`Generating intro images into ${OUT_DIR}\n`);

for (const { age, scenes } of AGE_PROMPTS) {
  console.log(`\n=== Age ${age} ===`);

  for (let v = 0; v < VARIANTS_PER_AGE; v++) {
    const filename = `age-${age}-${v}.jpg`;
    const outPath = join(OUT_DIR, filename);

    if (existsSync(outPath)) {
      console.log(`  ${filename} already exists, skipping`);
      continue;
    }

    const scene = scenes[v % scenes.length];
    console.log(`  Generating ${filename}...`);

    try {
      const buf = await generate(scene);
      writeFileSync(outPath, buf);
      console.log(`    Done (${Math.round(buf.length / 1024)}KB)`);
    } catch (e) {
      console.error(`    Failed: ${e.message}`);
    }

    // Small delay between requests
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.log("\nDone. Images in:", OUT_DIR);
