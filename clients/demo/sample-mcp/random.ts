/** Draws in [0, 1) that repeat for a seed. */
export function seededGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One seed out of several whole numbers, so that data can be drawn for a key without drawing what comes before it. */
export function mixedSeed(...parts: number[]): number {
  let hash = 0x9e3779b9;
  for (const part of parts) {
    hash = Math.imul(hash ^ part, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
  }
  return hash >>> 0;
}

export function pick<T>(items: readonly T[], index: number): T {
  const value = items[index % items.length];
  if (value === undefined) throw new Error("The sample list is empty.");
  return value;
}
