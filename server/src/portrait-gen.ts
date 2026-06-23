import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { logger } from "./logger.js";

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
  { slug: "age-07", figure: "7-year-old child," },
  { slug: "age-12", figure: "12-year-old preteen," },
  { slug: "age-16", figure: "16-year-old teenager with slightly slumped posture," },
  { slug: "age-20", figure: "person in their mid-twenties," },
];

function firstPortraitPrompt(figure: string, hair: string, clothing: string): string {
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

function agingPrompt(figure: string, hair: string, clothing: string): string {
  return [
    `The same character from the reference image, now ${figure}`,
    `Seen from behind at the same cozy desk, same ${hair}, same ${clothing}.`,
    `They have grown — body proportions have changed with age — but the setting and mood are the same.`,
    `Dark cozy bedroom, warm amber desk lamp glow, rain on window, bookshelf behind.`,
    `Lo-fi anime illustration style, muted warm palette, soft film grain. Square 1:1.`,
    `No text, no watermark.`,
  ].join(" ");
}

async function generateFirst(
  figure: string,
  hair: string,
  clothing: string,
  outPath: string,
  apiKey: string,
): Promise<Buffer> {
  const res = await fetch("https://openrouter.ai/api/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
    body: JSON.stringify({
      model: "openai/gpt-image-2",
      prompt: firstPortraitPrompt(figure, hair, clothing),
      n: 1,
      size: "1024x1024",
      output_format: "png",
    }),
  });

  const data = (await res.json()) as {
    error?: { message: string };
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  if (data.error) throw new Error(data.error.message);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image returned from OpenRouter");

  const buf = Buffer.from(b64, "base64");
  writeFileSync(outPath, buf);
  return buf;
}

async function generateWithReference(
  figure: string,
  hair: string,
  clothing: string,
  outPath: string,
  referenceImagePath: string,
  apiKey: string,
): Promise<void> {
  // Note: OpenRouter's gpt-image-2 doesn't support image-to-image, so we
  // generate a fresh image using the aging prompt instead of the reference
  const res = await fetch("https://openrouter.ai/api/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
    body: JSON.stringify({
      model: "openai/gpt-image-2",
      prompt: agingPrompt(figure, hair, clothing),
      n: 1,
      size: "1024x1024",
      output_format: "png",
    }),
  });

  const data = (await res.json()) as {
    error?: { message: string };
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  if (data.error) throw new Error(data.error.message);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("No image returned from OpenRouter");

  writeFileSync(outPath, Buffer.from(b64, "base64"));
}

function apiKey(): string | null {
  if (process.env.DISABLE_PORTRAITS === "1") return null;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) logger.warn("portrait_skipped", { reason: "OPENROUTER_API_KEY not set" });
  return key ?? null;
}

async function generateWithRetry(
  gameId: string,
  slug: string,
  figure: string,
  hair: string,
  clothing: string,
  outPath: string,
  prevPath: string | null,
  key: string,
): Promise<void> {
  let attempt = 0;
  while (!existsSync(outPath)) {
    try {
      if (!prevPath) {
        await generateFirst(figure, hair, clothing, outPath, key);
      } else {
        await generateWithReference(figure, hair, clothing, outPath, prevPath, key);
      }
      logger.info("portrait_ready", { gameId, slug });
    } catch (e) {
      attempt++;
      logger.error("portrait_attempt_failed", { gameId, slug, attempt, error: (e as Error).message });
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// Called at game creation — generates only the first portrait (age-03) so the
// guardian screen has something to show as quickly as possible.
export async function generateFirstPortrait(gameId: string): Promise<void> {
  const key = apiKey();
  if (!key) return;

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const { hair, clothing } = childDescriptorFromGameId(gameId);
  const { slug, figure } = AGE_BUCKETS[0];
  const outPath = path.join(dir, `${slug}.png`);

  if (existsSync(outPath)) return;
  await generateWithRetry(gameId, slug, figure, hair, clothing, outPath, null, key);
}

// Lock prevents two concurrent callers from generating the same portrait.
const inProgress = new Set<string>();

// Called when a conversation begins — generates the next missing portrait in the
// chain so it's ready by the time the player reaches the following event.
export async function generateNextPortrait(gameId: string): Promise<void> {
  const key = apiKey();
  if (!key) return;

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const { hair, clothing } = childDescriptorFromGameId(gameId);

  // Find the first missing portrait and the last completed one (used as reference).
  let prevPath: string | null = null;
  let next: (typeof AGE_BUCKETS)[0] | null = null;

  for (const bucket of AGE_BUCKETS) {
    const p = path.join(dir, `${bucket.slug}.png`);
    if (existsSync(p)) {
      prevPath = p;
    } else {
      next = bucket;
      break;
    }
  }

  if (!next) return; // all portraits already done

  const lockKey = `${gameId}:${next.slug}`;
  if (inProgress.has(lockKey)) return; // already in flight
  inProgress.add(lockKey);

  const outPath = path.join(dir, `${next.slug}.png`);
  try {
    await generateWithRetry(gameId, next.slug, next.figure, hair, clothing, outPath, prevPath, key);
  } finally {
    inProgress.delete(lockKey);
  }
}
