/**
 * Generate a pool of starter child portraits for immediate display.
 * These are pre-generated images that show before the AI generates
 * a game-specific portrait.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... node scripts/gen-starter-portraits.mjs
 *   OPENROUTER_API_KEY=sk-... node scripts/gen-starter-portraits.mjs --dry-run
 *   OPENROUTER_API_KEY=sk-... node scripts/gen-starter-portraits.mjs --gender boy --age age-03 --count 1
 *
 * Output: client/public/portraits/starters/{gender}/{age-slug}/{N}.png
 *
 * Generates 30 variants per gender+age combo by default (450 total).
 * Run with --count 1 first to verify a single image looks correct.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(__dir, "../client/public/portraits/starters");

const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const filterGender = args.includes("--gender") ? args[args.indexOf("--gender") + 1] : null;
const filterAge = args.includes("--age") ? args[args.indexOf("--age") + 1] : null;
const countPerCombo = args.includes("--count") ? parseInt(args[args.indexOf("--count") + 1], 10) : 30;

const GENDERS = ["nonbinary", "boy", "girl"];

const FIGURES = {
  nonbinary: [
    { slug: "age-03", figure: "tiny round-headed toddler," },
    { slug: "age-07", figure: "small child with a slightly larger frame," },
    { slug: "age-12", figure: "young person, medium build, starting to grow taller," },
    { slug: "age-16", figure: "lanky young person with slightly slumped posture," },
    { slug: "age-20", figure: "person in their mid-twenties," },
  ],
  boy: [
    { slug: "age-03", figure: "tiny round-headed toddler," },
    { slug: "age-07", figure: "small boy with a slightly larger frame," },
    { slug: "age-12", figure: "young boy, medium build, starting to grow taller," },
    { slug: "age-16", figure: "lanky young man with slightly slumped posture," },
    { slug: "age-20", figure: "young man in his mid-twenties," },
  ],
  girl: [
    { slug: "age-03", figure: "tiny round-headed toddler," },
    { slug: "age-07", figure: "small girl with a slightly larger frame," },
    { slug: "age-12", figure: "young girl, medium build, starting to grow taller," },
    { slug: "age-16", figure: "lanky young woman with slightly slumped posture," },
    { slug: "age-20", figure: "young woman in her mid-twenties," },
  ],
};

const HAIR_POOL = [
  "dark brown wavy shoulder-length hair",
  "black short and slightly curly hair",
  "auburn long and straight hair",
  "honey blonde loosely braided hair",
  "light brown fluffy and thick hair",
];
const CLOTHING_POOL = [
  "soft grey hoodie",
  "dusty blue oversized sweater",
  "forest green cardigan",
  "warm cream loose t-shirt",
  "faded burgundy hoodie",
];

function pickRandom(arr, seed) {
  return arr[seed % arr.length];
}

function portraitPrompt(figure, hair, clothing) {
  return [
    `Lo-fi anime illustration of a ${figure} with ${hair},`,
    `wearing a ${clothing}, seen from behind,`,
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

async function generateImage(prompt) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences - Starter Portraits",
    },
    body: JSON.stringify({
      model: "openai/gpt-5-image-mini",
      messages: [{ role: "user", content: `Generate an image: ${prompt}` }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const imgUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!imgUrl) throw new Error("No image returned from OpenRouter");
  const b64 = imgUrl.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(b64, "base64");
}

let total = 0;
let generated = 0;
let skipped = 0;

for (const gender of GENDERS) {
  if (filterGender && gender !== filterGender) continue;
  const ages = FIGURES[gender];

  for (const { slug, figure } of ages) {
    if (filterAge && slug !== filterAge) continue;
    const dir = join(OUT_ROOT, gender, slug);
    mkdirSync(dir, { recursive: true });

    const existing = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".png")).length : 0;
    const startFrom = existing;

    for (let i = startFrom; i < countPerCombo; i++) {
      total++;
      const outPath = join(dir, `${i}.png`);

      if (existsSync(outPath)) {
        skipped++;
        continue;
      }

      const hair = pickRandom(HAIR_POOL, i * 7 + gender.length);
      const clothing = pickRandom(CLOTHING_POOL, i * 13 + gender.length * 3);
      const prompt = portraitPrompt(figure, hair, clothing);

      if (dryRun) {
        console.log(`[dry-run] ${gender}/${slug}/${i}.png`);
        console.log(`  prompt: ${prompt.slice(0, 100)}…`);
        continue;
      }

      let attempt = 0;
      while (attempt < 3) {
        try {
          console.log(`Generating ${gender}/${slug}/${i}.png (${generated + 1}/${total})…`);
          const buf = await generateImage(prompt);
          writeFileSync(outPath, buf);
          generated++;
          console.log(`  ✓ ${Math.round(buf.length / 1024)}KB`);
          break;
        } catch (e) {
          attempt++;
          console.error(`  ✗ attempt ${attempt}: ${e.message}`);
          if (attempt >= 3) {
            console.error(`  ✗ Giving up on ${gender}/${slug}/${i}.png`);
            break;
          }
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
  }
}

console.log(`\nDone. Generated: ${generated}, Skipped: ${skipped}`);
console.log(`Output: ${OUT_ROOT}`);
