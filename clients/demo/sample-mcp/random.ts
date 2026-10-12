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

/**
 * Where `position` lands when `size` places are shuffled, the same for a seed. Every place is
 * landed on once, and one place costs the same whatever the size: the position's bits are
 * mixed in four rounds, again until the result is a place.
 */
export function shuffled(position: number, size: number, seed: number): number {
  const halfBits = Math.max(1, Math.ceil(Math.log2(size) / 2));
  const mask = (1 << halfBits) - 1;
  let place = position;
  do {
    let left = place >>> halfBits;
    let right = place & mask;
    for (let round = 0; round < 4; round += 1) {
      [left, right] = [right, left ^ (mixedSeed(seed, round, right) & mask)];
    }
    place = (left << halfBits) | right;
  } while (place >= size);
  return place;
}

/** The item a draw in [0, 1) falls on when each item takes room by its weight. */
export function weighted<T>(items: readonly T[], weightOf: (item: T) => number, draw: number): T {
  let ticket = draw * items.reduce((sum, item) => sum + weightOf(item), 0);
  return items.find((item) => (ticket -= weightOf(item)) < 0) ?? pick(items, items.length - 1);
}
