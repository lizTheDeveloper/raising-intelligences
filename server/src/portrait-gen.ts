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

import type { ChildGender } from "./types.js";

const AGE_BUCKETS_BY_GENDER: Record<ChildGender, Array<{ slug: string; figure: string }>> = {
  nonbinary: [
    { slug: "age-03", figure: "tiny round-headed toddler, maybe 3 years old," },
    { slug: "age-07", figure: "7-year-old child," },
    { slug: "age-12", figure: "12-year-old preteen," },
    { slug: "age-16", figure: "16-year-old teenager with slightly slumped posture," },
    { slug: "age-20", figure: "person in their mid-twenties," },
  ],
  boy: [
    { slug: "age-03", figure: "tiny round-headed toddler boy, maybe 3 years old," },
    { slug: "age-07", figure: "7-year-old boy," },
    { slug: "age-12", figure: "12-year-old boy," },
    { slug: "age-16", figure: "16-year-old teenage boy with slightly slumped posture," },
    { slug: "age-20", figure: "young man in his mid-twenties," },
  ],
  girl: [
    { slug: "age-03", figure: "tiny round-headed toddler girl, maybe 3 years old," },
    { slug: "age-07", figure: "7-year-old girl," },
    { slug: "age-12", figure: "12-year-old girl," },
    { slug: "age-16", figure: "16-year-old teenage girl with slightly slumped posture," },
    { slug: "age-20", figure: "young woman in her mid-twenties," },
  ],
};

function getAgeBuckets(gender: ChildGender = "nonbinary") {
  return AGE_BUCKETS_BY_GENDER[gender];
}

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

interface ImageResponse {
  error?: { message: string };
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string } }>;
    };
  }>;
}

async function generateImage(prompt: string, apiKey: string): Promise<Buffer> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "Raising Intelligences",
    },
    body: JSON.stringify({
      model: "openai/gpt-5-image-mini",
      messages: [{ role: "user", content: `Generate an image: ${prompt}` }],
    }),
  });

  const data = (await res.json()) as ImageResponse;
  if (data.error) throw new Error(data.error.message);
  const imgUrl = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!imgUrl) throw new Error("No image returned from OpenRouter");
  const b64 = imgUrl.replace(/^data:image\/\w+;base64,/, "");
  return Buffer.from(b64, "base64");
}

async function generateFirst(
  figure: string,
  hair: string,
  clothing: string,
  outPath: string,
  apiKey: string,
): Promise<Buffer> {
  const buf = await generateImage(firstPortraitPrompt(figure, hair, clothing), apiKey);
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
  const buf = await generateImage(agingPrompt(figure, hair, clothing), apiKey);
  writeFileSync(outPath, buf);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function apiKey(): string | null {
  if (process.env.DISABLE_PORTRAITS === "1") return null;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) logger.warn("portrait_skipped", { reason: "OPENROUTER_API_KEY not set" });
  return key ?? null;
}

const MAX_PORTRAIT_ATTEMPTS = 5;

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
    if (attempt >= MAX_PORTRAIT_ATTEMPTS) {
      logger.error("portrait_generation_abandoned", { gameId, slug, attempts: attempt });
      return;
    }
    try {
      if (!prevPath) {
        await generateFirst(figure, hair, clothing, outPath, key);
      } else {
        await generateWithReference(figure, hair, clothing, outPath, prevPath, key);
      }
      logger.info("portrait_ready", { gameId, slug });
      return;
    } catch (e) {
      attempt++;
      logger.error("portrait_attempt_failed", { gameId, slug, attempt, error: (e as Error).message });
      if (attempt >= MAX_PORTRAIT_ATTEMPTS) {
        logger.error("portrait_give_up", { gameId, slug, attempts: attempt });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  logger.warn("portrait_generation_abandoned", { gameId, slug, maxAttempts: MAX_PORTRAIT_ATTEMPTS });
}

function momentPrompt(visualPrompt: string): string {
  return [
    `Lo-fi anime illustration: ${visualPrompt}.`,
    `Warm amber and golden lighting, dark cozy atmosphere.`,
    `Muted warm palette, soft film grain, slightly desaturated,`,
    `gentle nostalgic mood, lo-fi music aesthetic.`,
    `Flat illustration style, clean lines, no text, no watermark.`,
    `Square composition 1:1.`,
  ].join(" ");
}

export async function generateMomentIllustrations(
  gameId: string,
  moments: Array<{ visualPrompt: string; sortOrder: number }>
): Promise<Array<{ sortOrder: number; imagePath: string | null }>> {
  const key = apiKey();
  if (!key) {
    return moments.map(m => ({ sortOrder: m.sortOrder, imagePath: null }));
  }

  if (!UUID_RE.test(gameId)) {
    return moments.map(m => ({ sortOrder: m.sortOrder, imagePath: null }));
  }

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const results = await Promise.allSettled(
    moments.map(async (m) => {
      const filename = `moment-${String(m.sortOrder).padStart(2, "0")}.png`;
      const outPath = path.join(dir, filename);
      const relativePath = `portraits/${gameId}/${filename}`;

      try {
        const buf = await generateImage(momentPrompt(m.visualPrompt), key);
        writeFileSync(outPath, buf);
        logger.info("moment_illustration_ready", { gameId, filename });
        return { sortOrder: m.sortOrder, imagePath: relativePath };
      } catch (e) {
        logger.error("moment_illustration_failed", {
          gameId, filename, error: (e as Error).message,
        });
        return { sortOrder: m.sortOrder, imagePath: null };
      }
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { sortOrder: moments[i].sortOrder, imagePath: null }
  );
}

// Called at game creation — generates only the first portrait (age-03) so the
// guardian screen has something to show as quickly as possible.
export async function generateFirstPortrait(gameId: string, gender: ChildGender = "nonbinary"): Promise<void> {
  if (!UUID_RE.test(gameId)) {
    logger.warn("portrait_invalid_game_id", { gameId });
    return;
  }
  const key = apiKey();
  if (!key) return;

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const { hair, clothing } = childDescriptorFromGameId(gameId);
  const buckets = getAgeBuckets(gender);
  const { slug, figure } = buckets[0];
  const outPath = path.join(dir, `${slug}.png`);

  if (existsSync(outPath)) return;
  await generateWithRetry(gameId, slug, figure, hair, clothing, outPath, null, key);
}

// Lock prevents two concurrent callers from generating the same portrait.
const inProgress = new Set<string>();

// Called when a conversation begins — generates the next missing portrait in the
// chain so it's ready by the time the player reaches the following event.
export async function generateNextPortrait(gameId: string, gender: ChildGender = "nonbinary"): Promise<void> {
  if (!UUID_RE.test(gameId)) {
    logger.warn("portrait_invalid_game_id", { gameId });
    return;
  }
  const key = apiKey();
  if (!key) return;

  const dir = path.join(PORTRAITS_DIR, gameId);
  mkdirSync(dir, { recursive: true });

  const { hair, clothing } = childDescriptorFromGameId(gameId);
  const buckets = getAgeBuckets(gender);

  // Find the first missing portrait and the last completed one (used as reference).
  let prevPath: string | null = null;
  let next: (typeof buckets)[0] | null = null;

  for (const bucket of buckets) {
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
