export const STALE_CHUNK_RELOAD_COOLDOWN_MS = 60_000;

const STALE_CHUNK_RELOAD_KEY = "vivd-catalyst:stale-chunk-reload";

export interface StaleChunkRecoveryOptions {
  target?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
  now?: () => number;
}

/**
 * Reloads an already-open client once when a deployment removes a lazy chunk
 * referenced by the old page. The cooldown prevents a broken deployment from
 * causing a reload loop.
 */
export function installStaleChunkRecovery(
  options: StaleChunkRecoveryOptions = {}
): () => void {
  const target = options.target ?? window;
  const storage = options.storage ?? window.sessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  let fallbackLastReloadAt: number | undefined;
  const onPreloadError = (event: Event) => {
    event.preventDefault();
    const currentTime = now();
    let lastReloadAt = fallbackLastReloadAt;
    try {
      const storedReloadAt = storage.getItem(STALE_CHUNK_RELOAD_KEY);
      if (storedReloadAt !== null) {
        lastReloadAt = Number(storedReloadAt);
      }
    } catch {
      // Storage can be disabled; the in-memory cooldown still prevents loops.
    }
    if (
      lastReloadAt !== undefined &&
      Number.isFinite(lastReloadAt) &&
      currentTime - lastReloadAt < STALE_CHUNK_RELOAD_COOLDOWN_MS
    ) {
      return;
    }
    fallbackLastReloadAt = currentTime;
    try {
      storage.setItem(STALE_CHUNK_RELOAD_KEY, String(currentTime));
    } catch {
      // The in-memory marker above is sufficient for the current page.
    }
    reload();
  };

  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}
