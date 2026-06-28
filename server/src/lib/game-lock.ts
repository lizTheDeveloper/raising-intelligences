export function withGameLock<T>(
  locks: Map<string, Promise<void>>,
  gameId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = locks.get(gameId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const settled = next.then(() => {}, () => {});
  settled.then(() => { if (locks.get(gameId) === settled) locks.delete(gameId); });
  locks.set(gameId, settled);
  return next;
}
