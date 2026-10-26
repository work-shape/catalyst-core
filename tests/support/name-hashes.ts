import { hash } from "node:crypto";

// Customer and accounting-vendor vocabulary is stored only as SHA-256 digests.
// Customer names stay out of every product source.
const customers = new Set([
  "9aabd541ce977040b2cdc9d7d21883d25f58b0821ca218a682d6b5d404be7aa6",
  "96c8340a09cd1df7427b0ad81f9fef44a7f294931f33e8c117d418911ea87729",
  "d0ef2cc1546e83f0042e7afa43f7d3e2711b888ded35a992174d2e297a7b4cc9",
  "859bac1754749f06e7756f08a9b0291eab97245dc5e88641125a2b26b1271de9"
]);
// Accounting-vendor names stay out of core; a private package that connects the vendor names it.
const vendors = new Set([
  "5053caeaa1acb98296ef3727d28b82a942404d291509cebc21aabf779026e133",
  "b42bb8543311b2c003067e568e9c0d983f09a986102903d9b3512ac1b607c9b0"
]);

// The same vocabulary recurs across thousands of source lines. Hash each candidate once.
const matches = new Map<string, "customer" | "vendor" | undefined>();

function kindOf(word: string): "customer" | "vendor" | undefined {
  if (matches.has(word)) return matches.get(word);
  const digest = hash("sha256", word);
  const kind = customers.has(digest) ? "customer" : vendors.has(digest) ? "vendor" : undefined;
  matches.set(word, kind);
  return kind;
}

/**
 * The denied words and word pairs in a text. `vendors: false` checks customer names only, for a
 * repository whose packages may name the vendors they connect.
 */
export function deniedNames(text: string, options: { vendors?: boolean } = {}): string[] {
  const withVendors = options.vendors ?? true;
  const lower = text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase();
  const words = [...lower.matchAll(/[a-z]+|[0-9]+/gu)];
  const candidates = new Set<string>();
  for (const [index, word] of words.entries()) {
    candidates.add(word[0]);
    const next = words[index + 1];
    // A word pair can be prose or an identifier, but not unrelated syntax tokens.
    if (next && /^[\s_-]*$/u.test(lower.slice(word.index + word[0].length, next.index))) {
      candidates.add(word[0] + next[0]);
    }
  }
  return [...candidates].filter((word) => {
    const kind = kindOf(word);
    return kind === "customer" || (kind === "vendor" && withVendors);
  });
}
