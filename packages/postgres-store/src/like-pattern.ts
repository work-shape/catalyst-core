/** A pattern for `like` and `ilike` that finds `text` anywhere and reads its wildcards as text. */
export function containsPattern(text: string): string {
  return `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}
