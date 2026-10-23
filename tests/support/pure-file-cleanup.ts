import { afterAll, vi } from "vitest";

// Match the old worker boundary: a file-scoped stub lives through the whole file. Stack-ordered
// teardown runs the file's own afterAll hooks first, then restores globals for the next file.
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
