// German collation, as the rest of the interface sorts names: "Äpfel" stands with "A".
const railCollator = new Intl.Collator("de");

/**
 * The rail's Apps and projects, shown in alphabetical order by the name people read. Which of
 * them are shown follows use; where they stand does not, so opening one never moves it. `items`
 * come in as they were picked and are not changed; ties fall back to `tiebreak`.
 */
export function alphabetically<Item>(
  items: readonly Item[],
  name: (item: Item) => string,
  tiebreak: (item: Item) => string
): Item[] {
  return [...items].sort(
    (left, right) =>
      railCollator.compare(name(left), name(right)) ||
      railCollator.compare(tiebreak(left), tiebreak(right))
  );
}
