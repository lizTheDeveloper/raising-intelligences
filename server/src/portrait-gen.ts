import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";

export const PORTRAITS_DIR =
  process.env.PORTRAITS_DIR ?? path.join(process.cwd(), "portraits");

const HAIR_COLORS = ["dark brown", "black", "auburn", "honey blonde", "light brown"];
const HAIR_STYLES = [
  "wavy shoulder-length",
  "short and slightly curly",
  "long and straight",
  "loosely braided",
  "fluffy and thick",
];
const CLOTHING_COLORS = ["soft grey", "dusty blue", "forest green", "warm cream", "faded burgundy"];
const CLOTHING_TYPES = ["hoodie", "oversized sweater", "cardigan", "loose t-shirt"];

function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function childDescriptorFromGameId(gameId: string) {
  const h = hashCode(gameId);
  const hairColor = HAIR_COLORS[h % HAIR_COLORS.length];
  const hairStyle = HAIR_STYLES[(h >>> 4) % HAIR_STYLES.length];
  const clothingColor = CLOTHING_COLORS[(h >>> 8) % CLOTHING_COLORS.length];
  const clothingType = CLOTHING_TYPES[(h >>> 12) % CLOTHING_TYPES.length];
  return {
    hair: `${hairColor} ${hairStyle} hair`,
    clothing: `${clothingColor} ${clothingType}`,
  };
}

const AGE_BUCKETS = [
  { slug: "age-03", figure: "tiny round-headed toddler, maybe 3 years old," },
  { slug: "age-07", figure: "small 7-year-old child," },
  { slug: "age-12", figure: "12-year-old preteen," },
  { slug: "age-16", figure: "16-year-old teenager with slightly slumped posture," },
  { slug: "age-20", figure: "person in their mid-twenties," },
];

function buildPrompt(figure: string, hair: string, clothing: string): string {
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

async function generateOne(
  slug: string,
  figure: string,
  hair: string,
  clothing: string,
  outPath: string,
  apiKey: string,
): Promise<void> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: buildPrompt(figure, hair, clothing) }],
    }),
  });

  const data = (await res.json()) as {
    error?: { message: string };
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url: string } }> } }>;
  };

  if (data.error) throw new Error(data.error.message);
  const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`No image returned for ${slug}`);

  const b64 = url.replace(/^data:image\/\w+;base64,/, "");
  writeFileSync(outPath, Buffer.from(b64, "base64"));
}

export async function generatePortraitsForGame(gameId: string): Promise<void> {
  // Opt-out used by the test harness (and any environment that should not spend
  // on image generation) — skips the expensive portrait calls entirely.
  if (process.env.DISABLE_PORTRAITS === "1") return;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return;

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const { hair, clothing } = childDescriptorFromGameId(gameId);

  await Promise.allSettled(
    AGE_BUCKETS.map(({ slug, figure }) => {
      const outPath = path.join(dir, `${slug}.png`);
      if (existsSync(outPath)) return Promise.resolve();
      return generateOne(slug, figure, hair, clothing, outPath, apiKey).catch((e) => {
        console.error(`[portraits] ${gameId}/${slug} failed:`, e.message);
      });
    }),
  );
}
