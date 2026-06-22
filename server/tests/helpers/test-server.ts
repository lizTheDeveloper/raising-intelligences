import type { AddressInfo } from "net";
import path from "path";
import { fileURLToPath } from "url";
import { buildServer, type BuiltServer } from "../../src/app.js";
import { OpenRouterLLMClient } from "../../src/llm/openrouter.js";
import { InMemoryGameRepository } from "../../src/db/repository.js";
import { CassetteLLMClient, type CassetteMode } from "./cassette.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASSETTE_DIR = path.join(__dirname, "..", "fixtures", "cassettes");

/** Fixed seed for every recorded playthrough — keeps cassettes reproducible. */
export const TEST_SEED = Number(process.env.LLM_SEED ?? 424242);

/** Cassette mode from the environment; CI replays, developers record. */
export function cassetteMode(): CassetteMode {
  const m = process.env.LLM_CACHE_MODE;
  if (m === "record" || m === "auto") return m;
  return "replay";
}

export interface TestServer extends BuiltServer {
  /** Base HTTP URL, e.g. http://127.0.0.1:54123 */
  baseUrl: string;
  /** The in-memory repository, for asserting persistence directly. */
  memRepo: InMemoryGameRepository;
  /** Calls served from / written to the cassette during this test. */
  cassette: CassetteLLMClient;
  stop: () => Promise<void>;
}

/**
 * Boot the real application stack in-process for an integration/E2E test:
 * the genuine express app, socket.io server, engines, state machine, and an
 * in-memory repository — only the LLM provider is wrapped in a record/replay
 * cassette. Listens on an ephemeral port and resolves once it is accepting
 * connections.
 *
 * @param cassetteName  File under tests/fixtures/cassettes/ backing this run.
 */
export async function createTestServer(cassetteName: string): Promise<TestServer> {
  // Never spend on portrait image generation during tests.
  process.env.DISABLE_PORTRAITS = "1";

  const mode = cassetteMode();
  // The real OpenRouter client is only constructed for record/auto runs; in
  // replay mode it is never called, so a missing API key is fine.
  const real = new OpenRouterLLMClient("standard", undefined, "kid_family_chat", TEST_SEED);
  const cassette = new CassetteLLMClient(real, {
    file: path.join(CASSETTE_DIR, `${cassetteName}.json`),
    mode,
    seed: TEST_SEED,
  });

  const memRepo = new InMemoryGameRepository();
  const built = buildServer({
    llm: cassette,
    repo: memRepo,
    enableEviction: false,
    allowedOrigin: "*",
    // The test socket client dials the default path; pin it so the harness is
    // independent of NODE_ENV (which would otherwise switch to the prod subpath).
    socketPath: "/socket.io",
  });

  await new Promise<void>((resolve) => {
    built.httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = built.httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const stop = async () => {
    await built.close();
  };

  return { ...built, baseUrl, memRepo, cassette, stop };
}
