/**
 * Model Search — benchmark candidate kid LLMs for personality diversity.
 *
 * Usage:
 *   npx tsx scripts/model-search.ts "qwen/qwen3.8-flash" "nvidia/nemotron-3.5-lightning:free"
 *   npx tsx scripts/model-search.ts                # re-display all previous results
 *
 * Requires: OPENROUTER_API_KEY env var
 * Optional: DATABASE_URL (for storing results in kid_model_benchmarks)
 *
 * Pulls 6 real kid_family_chat prompts from Langfuse (cached locally after
 * first run), runs each candidate model, scores responses for archetype
 * convergence, and prints a comparison table.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, ".prompt-cache");

// --- Langfuse prompt pulling ---

interface CachedPrompt {
  id: string;       // "age3_chat_1", "age7_chat_1", "age12_chat_1", etc.
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const LANGFUSE_HOST = process.env.LANGFUSE_BASEURL ?? "https://langfuse.multiversegames.ai";
const LANGFUSE_PUBLIC = process.env.LANGFUSE_PUBLIC_KEY;
const LANGFUSE_SECRET = process.env.LANGFUSE_SECRET_KEY;

function requireLangfuseEnv(): { publicKey: string; secretKey: string } {
  const missing: string[] = [];
  if (!LANGFUSE_PUBLIC) missing.push("LANGFUSE_PUBLIC_KEY");
  if (!LANGFUSE_SECRET) missing.push("LANGFUSE_SECRET_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. ` +
      `Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (and optionally LANGFUSE_BASEURL, ` +
      `default https://langfuse.multiversegames.ai) to pull the prompt corpus.`
    );
  }
  return { publicKey: LANGFUSE_PUBLIC!, secretKey: LANGFUSE_SECRET! };
}

async function langfuseGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const { publicKey, secretKey } = requireLangfuseEnv();
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const url = new URL(path, LANGFUSE_HOST);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Langfuse ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pullPrompts(): Promise<CachedPrompt[]> {
  const cacheFile = join(CACHE_DIR, "prompts.json");
  if (existsSync(cacheFile)) {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  }

  console.log("Pulling prompts from Langfuse (first run)...");
  await mkdir(CACHE_DIR, { recursive: true });

  const targetAges = [3, 7, 12];
  const prompts: CachedPrompt[] = [];

  // Pull kid_family_chat observations, paginating through pages of 100
  const allObs: Array<{ input: unknown; output: unknown }> = [];
  for (let page = 1; page <= 5; page++) {
    const data = await langfuseGet("/api/public/observations", {
      type: "GENERATION",
      name: "kid_family_chat",
      limit: "100",
      page: String(page),
    }) as { data: Array<{ input: unknown; output: unknown }> };
    allObs.push(...data.data);
    if (data.data.length < 100) break;
  }
  const data = { data: allObs };

  for (const age of targetAges) {
    // Find observations where the system prompt mentions the target age
    const agePattern = new RegExp(`(?:a|an) ${age}-year-old`);
    const matches = data.data.filter((obs) => {
      const input = obs.input as { system?: string } | undefined;
      return input?.system && agePattern.test(input.system);
    });

    if (matches.length === 0) {
      console.warn(`No observations found for age ${age}`);
      continue;
    }

    // Take the first 2 matches per age for variety
    for (let i = 0; i < Math.min(2, matches.length); i++) {
      const obs = matches[i];
      const input = obs.input as { system: string; messages?: Array<{ role: string; content: string }> };
      prompts.push({
        id: `age${age}_chat_${i + 1}`,
        system: input.system,
        messages: (input.messages ?? [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-3) as Array<{ role: "user" | "assistant"; content: string }>,
      });
    }
  }

  await writeFile(cacheFile, JSON.stringify(prompts, null, 2));
  console.log(`Cached ${prompts.length} prompts to ${cacheFile}`);
  return prompts;
}

// --- Scoring ---

const SENSORY_WORDS = /\b(scratchy|buzzy|sticky|loud|sharp|wobbly|heavy|tight|fast|cold|prickly|itchy|rough|smooth|squish|crunch|tingle|hum|buzz|rumble)\b/gi;
const GRANDMA_PATTERN = /\b(grandma|grammy|nana|grandmother|gran|granny)\b/i;
const HELEN_PATTERN = /\bgrandma\s*helen\b|\bhelen\b.*\bgrandma\b/i;
const TEACHER_PATTERN = /\b(mrs?\.\s*gable|mrs?\.\s*patterson|teacher.*sigh|teacher.*referral)\b/i;
const AUNT_PATTERN = /\b(aunt|auntie)\s+\w+/i;

const ORDER_COPING = /\b(lin(e|ing)\s*up|measur|count|exact|precise|gap|straight|order|arrange|sort)\b/i;
const FREEZE_COPING = /\b(freeze|froze|frozen|blank\s*face|going?\s*still|stone|rock|stiff|locked)\b/i;
const NEGOTIATE_COPING = /\b(trade|deal|bargain|negotiate|swap|offer|exchange|if\s*(?:you|I)\s*(?:do|give))\b/i;
const CREATE_COPING = /\b(cook|bake|draw|paint|build|make|craft|create|garden|plant)\b/i;

interface BenchmarkResult {
  modelSlug: string;
  promptId: string;
  sensoryScore: number;
  castScore: number;
  copingArchetype: string;
  englishQuality: boolean;
  responseTokens: number;
  costUsd: number;
  rawExcerpt: string;
}

function scoreResponse(text: string): Omit<BenchmarkResult, "modelSlug" | "promptId" | "responseTokens" | "costUsd"> {
  const words = text.split(/\s+/).length;

  // Sensory score: count of sensory words / total words, capped at 1.0
  const sensoryMatches = text.match(SENSORY_WORDS) ?? [];
  const sensoryScore = Math.min(1.0, sensoryMatches.length / Math.max(words, 1) * 10);

  // Cast score: 0.25 per archetype element present
  let castScore = 0;
  if (GRANDMA_PATTERN.test(text)) castScore += 0.25;
  if (HELEN_PATTERN.test(text)) castScore += 0.25;
  if (TEACHER_PATTERN.test(text)) castScore += 0.25;
  if (AUNT_PATTERN.test(text)) castScore += 0.25;

  // Coping archetype
  let copingArchetype = "other";
  if (ORDER_COPING.test(text)) copingArchetype = "ordering";
  else if (FREEZE_COPING.test(text)) copingArchetype = "freezing";
  else if (NEGOTIATE_COPING.test(text)) copingArchetype = "negotiating";
  else if (CREATE_COPING.test(text)) copingArchetype = "creating";

  // English quality: check for CJK characters (common with Qwen/DeepSeek)
  const cjkChars = text.match(/[一-鿿㐀-䶿]/g) ?? [];
  const englishQuality = cjkChars.length < 3;

  return {
    sensoryScore: Math.round(sensoryScore * 100) / 100,
    castScore,
    copingArchetype,
    englishQuality,
    rawExcerpt: text.slice(0, 500),
  };
}

// --- Model calling ---

async function callModel(
  client: OpenAI,
  model: string,
  prompt: CachedPrompt
): Promise<{ text: string; tokens: number; cost: number }> {
  const msgs: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: prompt.system },
    ...prompt.messages,
  ];
  if (prompt.messages.length === 0 || prompt.messages[prompt.messages.length - 1].role !== "user") {
    msgs.push({ role: "user", content: "(The child looks at their parents, waiting.)" });
  }

  try {
    const response = await client.chat.completions.create(
      { model, messages: msgs, max_tokens: 500 },
      { signal: AbortSignal.timeout(60_000) }
    );
    const text = response.choices[0]?.message?.content ?? "";
    const tokens = response.usage?.completion_tokens ?? 0;
    const cost = typeof (response.usage as any)?.cost === "number" ? (response.usage as any).cost : 0;
    return { text, tokens, cost };
  } catch (e) {
    console.error(`  ERROR calling ${model}: ${e}`);
    return { text: "", tokens: 0, cost: 0 };
  }
}

// --- DB storage ---

async function storeResult(result: BenchmarkResult): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const pg = await import("pg");
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO kid_model_benchmarks
         (model_slug, prompt_id, sensory_score, cast_score, coping_archetype,
          english_quality, response_tokens, cost_usd, raw_excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        result.modelSlug, result.promptId, result.sensoryScore,
        result.castScore, result.copingArchetype, result.englishQuality,
        result.responseTokens, result.costUsd, result.rawExcerpt,
      ]
    );
  } finally {
    await pool.end();
  }
}

// --- Main ---

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not set");
    process.exit(1);
  }

  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    defaultHeaders: {
      "HTTP-Referer": "https://raisingintelligences.com",
      "X-Title": "RI Model Search",
    },
  });

  const models = process.argv.slice(2);
  const prompts = await pullPrompts();

  if (models.length === 0) {
    console.log("No models specified. Pass model slugs as arguments.");
    console.log("Example: npx tsx scripts/model-search.ts 'qwen/qwen3.8-flash' 'nvidia/nemotron-3.5-lightning:free'");
    process.exit(0);
  }

  console.log(`\nBenchmarking ${models.length} models x ${prompts.length} prompts = ${models.length * prompts.length} calls\n`);

  const results: BenchmarkResult[] = [];

  for (const model of models) {
    console.log(`\n--- ${model} ---`);
    for (const prompt of prompts) {
      process.stdout.write(`  ${prompt.id}: `);
      const { text, tokens, cost } = await callModel(client, model, prompt);
      if (!text) { console.log("EMPTY"); continue; }

      const scores = scoreResponse(text);
      const result: BenchmarkResult = {
        modelSlug: model,
        promptId: prompt.id,
        responseTokens: tokens,
        costUsd: cost,
        ...scores,
      };
      results.push(result);
      await storeResult(result);
      console.log(
        `sensory=${scores.sensoryScore} cast=${scores.castScore} ` +
        `coping=${scores.copingArchetype} eng=${scores.englishQuality ? "OK" : "FAIL"}`
      );
    }
  }

  // --- Summary table ---
  console.log("\n\n## Model Comparison\n");
  console.log("| Model | Avg Sensory | Avg Cast | Coping | English | Diversity |");
  console.log("|-------|-------------|----------|--------|---------|-----------|");

  const byModel = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    if (!byModel.has(r.modelSlug)) byModel.set(r.modelSlug, []);
    byModel.get(r.modelSlug)!.push(r);
  }

  for (const [model, runs] of byModel) {
    const avgSensory = runs.reduce((s, r) => s + r.sensoryScore, 0) / runs.length;
    const avgCast = runs.reduce((s, r) => s + r.castScore, 0) / runs.length;
    const copings = [...new Set(runs.map((r) => r.copingArchetype))].join("/");
    const engOk = runs.every((r) => r.englishQuality);
    // Diversity = inverse of archetype match (lower sensory + lower cast = more diverse)
    const diversity = Math.round((1 - (avgSensory + avgCast) / 2) * 100);
    console.log(
      `| ${model} | ${avgSensory.toFixed(2)} | ${avgCast.toFixed(2)} | ${copings} | ${engOk ? "OK" : "FAIL"} | ${diversity}% |`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
