import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  installStaleChunkRecovery,
  STALE_CHUNK_RELOAD_COOLDOWN_MS
} from "../packages/chat-ui/src/stale-chunk-recovery";

describe("stale client chunk recovery", () => {
  it("reloads once per cooldown when Vite reports a missing lazy chunk", () => {
    const target = new EventTarget();
    const values = new Map<string, string>();
    const reload = vi.fn();
    let now = 1_000;
    const cleanup = installStaleChunkRecovery({
      target,
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
      },
      reload,
      now: () => now
    });

    const firstError = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(firstError);
    expect(firstError.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(1);

    now += STALE_CHUNK_RELOAD_COOLDOWN_MS;
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(2);

    cleanup();
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not serve the SPA document for missing hashed assets", () => {
    const config = readFileSync(
      new URL("../docker/nginx-spa.conf", import.meta.url),
      "utf8"
    );

    expect(config).toMatch(/location \/assets\/ \{[\s\S]*try_files \$uri =404;/);
    expect(config).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(config).toMatch(/location = \/index\.html \{[\s\S]*Cache-Control "no-cache";/);
  });
});
