import { localeCodes, type LocaleCode } from "./localization";

/**
 * The title the chat gives a conversation whose first message only attached files, in each
 * language: `one` for a single file without a name, `many` for several. The chat's dictionary
 * reads them, and the title job knows them as titles it may replace.
 */
export const ATTACHED_FILE_TITLES: Record<LocaleCode, { one: string; many: string }> = {
  en: { one: "Attached file", many: "{count} attached files" },
  de: { one: "Angehängte Datei", many: "{count} angehängte Dateien" }
};

/** The title for `count` attached files in every language, as the chat writes it. */
export function attachedFileTitles(count: number): string[] {
  return localeCodes.map((locale) =>
    count === 1
      ? ATTACHED_FILE_TITLES[locale].one
      : ATTACHED_FILE_TITLES[locale].many.replaceAll("{count}", String(count))
  );
}
