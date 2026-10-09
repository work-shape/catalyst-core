import type { LocaleCode } from "@vivd-catalyst/api-client";

/** The messages of one area of the interface: the same keys in every supported locale. */
export type TranslationArea<Key extends string = string> = Record<LocaleCode, Record<Key, string>>;

/**
 * Declares the messages of one area. The keys are taken from all locales together, so a key
 * that one locale has and another lacks does not compile.
 */
export function defineTranslations<Key extends string>(
  area: TranslationArea<Key>
): TranslationArea<Key> {
  return area;
}

/** The messages of several areas as one dictionary. */
export interface CombinedTranslations<Key extends string> {
  messages: TranslationArea<Key>;
  /**
   * Adds an area. A key belongs to one area: an area that declares a key again does not
   * compile, and the error names the key.
   */
  and<Added extends string>(
    area: TranslationArea<Added> &
      ([Key & Added] extends [never] ? unknown : { shared: Key & Added })
  ): CombinedTranslations<Key | Added>;
}

/** Starts the one dictionary of the interface. Every area joins it through `and`. */
export function combineTranslations<Key extends string>(
  messages: TranslationArea<Key>
): CombinedTranslations<Key> {
  return {
    messages,
    and: (area) =>
      combineTranslations({
        en: { ...messages.en, ...area.en },
        de: { ...messages.de, ...area.de }
      })
  };
}
