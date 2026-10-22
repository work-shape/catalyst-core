/** Browser layout coverage: English at both widths, plus German on a phone. */
export function layoutVariants<T extends number>(wide: T) {
  return [
    ["light", "en", wide],
    ["light", "en", 390],
    ["light", "de", 390]
  ] as const;
}
