/** `text` with the wildcards of `like` and `ilike` read as text. */
function escaped(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** A pattern for `like` and `ilike` that finds `text` anywhere and reads its wildcards as text. */
export function containsPattern(text: string): string {
  return `%${escaped(text)}%`;
}

/**
 * A pattern for `like` that finds what starts with `text`. It is constant, so the planner reads
 * it as a range of a prefix index.
 */
export function prefixPattern(text: string): string {
  return `${escaped(text)}%`;
}
