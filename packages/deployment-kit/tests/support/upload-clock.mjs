// Advance one minute per processing poll, keeping seven-minute cold-start regressions fast.
// Only loaded by the slow fake-API tests; production uses the real clock and timers.
const now = Date.now;
const later = globalThis.setTimeout;
let elapsed = 0;
Date.now = () => now() + elapsed;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 500) {
    elapsed += 60_000;
    return later(callback, 1, ...args);
  }
  return later(callback, delay, ...args);
};
