/** How long the debrief will wait for the scene's memory before showing without it. */
export const MEMORY_READ_TIMEOUT_MS = 3000;

/**
 * Reads the server's memory summary from GET /state, bounded in time.
 * Resolves to the summary text ("" if the game has none) or null when the read
 * failed, timed out or was malformed. Never throws and never waits longer than
 * `timeoutMs`, even when the fetch ignores its abort signal, so it is safe to
 * await on the way into the debrief.
 */
export async function readMemorySummary(
  url: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs: number = MEMORY_READ_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const read = (async (): Promise<string | null> => {
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data?.memorySummary === "string" ? data.memorySummary : "";
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
