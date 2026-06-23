/**
 * Generate a pool of lo-fi intro images using the Scenario API.
 * Creates 6 variants each for ages 0, 1, and 2. The client picks
 * a random variant per playthrough so "first steps" feels different.
 *
 * Usage:
 *   SCENARIO_API_KEY=... SCENARIO_API_SECRET=... node scripts/generate-intro-images.mjs
 *
 * Images are saved to client/public/portraits/intro/age-{N}-{V}.jpg
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, "../client/public/portraits/intro");
mkdirSync(OUT_DIR, { recursive: true });

const API_KEY = process.env.SCENARIO_API_KEY;
const API_SECRET = process.env.SCENARIO_API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error("SCENARIO_API_KEY and SCENARIO_API_SECRET required");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
const MODEL_ID = "model_3M8y65dexCzgcHYc8KJ8dXGJ";
const VARIANTS_PER_AGE = 6;

const AGE_PROMPTS = [
  {
    age: 0,
    scenes: [
      "newborn baby bundled in a soft blanket in a wooden crib, seen from above, tiny round head barely visible. Dark cozy nursery, warm amber nightlight glow, soft mobile hanging above",
      "newborn baby sleeping in a bassinet wrapped in a cream swaddle, seen from above. Dark bedroom, warm amber lamplight on nightstand, curtains drawn",
      "tiny newborn held against a shoulder, seen from behind, small blanket draped. Dark living room at night, warm lamp glow, rain on window",
      "newborn in a soft nest of blankets on a bed, curled up tiny, seen from above. Cozy dark room, warm amber light from a bedside lamp, night outside",
      "baby asleep in a car seat, tiny and bundled, seen from the side. Dark interior, warm streetlight glow through rain-streaked window",
      "newborn cradled in arms, seen from behind the holder, tiny head resting on shoulder. Dark hallway, warm light spilling from nursery doorway",
    ],
  },
  {
    age: 1,
    scenes: [
      "baby crawling on a wooden floor, seen from behind, small round head, wearing a soft cream onesie. Dark cozy bedroom, warm amber lamplight, rain on window at night, bookshelf in background",
      "baby sitting on a rug reaching for a stuffed animal, seen from behind. Dark living room, warm lamp glow, houseplant silhouette, rain on window",
      "baby pulling themselves up on a coffee table, seen from behind, wearing a soft grey onesie. Dark cozy room, warm amber light, nighttime",
      "baby crawling toward a glowing screen on the floor, seen from behind. Dark bedroom, warm amber desk lamp, bookshelves, rain outside",
      "baby sitting in a highchair looking out a rain-streaked window, seen from behind, small silhouette against the glass. Dark kitchen, warm pendant light",
      "baby reaching up from the floor toward a bookshelf, seen from behind, wearing a dusty blue onesie. Dark cozy room, warm lamplight, night",
    ],
  },
  {
    age: 2,
    scenes: [
      "tiny toddler taking first steps in a hallway, seen from behind, arms slightly out for balance, wearing a dusty blue oversized sweater. Dark cozy home, warm amber lamplight, rain on window at night",
      "small toddler standing at a window watching rain, seen from behind, hands pressed against glass. Dark bedroom, warm light behind them, night",
      "toddler walking unsteadily toward an open door with light spilling through, seen from behind. Dark hallway, warm amber glow, cozy home",
      "toddler reaching for a doorknob, standing on tiptoes, seen from behind, wearing a soft cream sweater. Dark cozy home, warm lamplight, rain outside",
      "small toddler toddling across a wooden floor carrying a stuffed animal, seen from behind. Dark living room, warm amber lamp, rain on windows",
      "toddler standing at the top of stairs looking down, seen from behind, holding onto the rail. Dark cozy home, warm light from below, nighttime",
    ],
  },
];

const STYLE_SUFFIX =
  "Muted warm palette, soft film grain, slightly desaturated, gentle nostalgic mood, lo-fi anime illustration style. No face visible, no text, no watermark. Square 1:1.";
const NEGATIVE = "face, eyes, looking at camera, bright colors, daylight, outdoor, vibrant, saturated, realistic photo";

async function generate(prompt) {
  const res = await fetch(
    `https://api.cloud.scenario.com/v1/models/${MODEL_ID}/inferences`,
    {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        parameters: {
          type: "txt2img",
          prompt: `${prompt} ${STYLE_SUFFIX}`,
          negativePrompt: NEGATIVE,
          negativePromptStrength: 0.7,
          numSamples: 1,
          width: 512,
          height: 512,
        },
      }),
    }
  );
  const data = await res.json();
  if (!data.job) throw new Error(JSON.stringify(data));
  return { jobId: data.job.jobId, inferenceId: data.inference.id };
}

async function pollJob(jobId) {
  while (true) {
    const res = await fetch(`https://api.cloud.scenario.com/v1/jobs/${jobId}`, {
      headers: { Authorization: AUTH },
    });
    const data = await res.json();
    if (data.job.status === "success") return;
    if (data.job.status === "failed") throw new Error(`Job ${jobId} failed`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function getImageUrl(inferenceId) {
  const res = await fetch(
    `https://api.cloud.scenario.com/v1/models/${MODEL_ID}/inferences/${inferenceId}`,
    { headers: { Authorization: AUTH } }
  );
  const data = await res.json();
  return data.inference.images[0]?.url;
}

async function downloadImage(url, outPath) {
  execSync(`curl -sL -o "${outPath}" "${url}"`);
  const { size } = await import("fs").then((fs) =>
    fs.promises.stat(outPath)
  );
  return size;
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
      const { jobId, inferenceId } = await generate(scene);
      console.log(`    Job ${jobId} started, polling...`);
      await pollJob(jobId);
      const url = await getImageUrl(inferenceId);
      if (!url) throw new Error("No image URL in result");
      const bytes = await downloadImage(url, outPath);
      console.log(`    ✓ Saved (${Math.round(bytes / 1024)}KB)`);
    } catch (e) {
      console.error(`    ✗ Failed: ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
}

console.log("\nDone. Images in:", OUT_DIR);
