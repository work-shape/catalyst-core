import type { OperationCallRuntime, LocaleCode } from "@work-shape/catalyst-core";

/**
 * What a German caller reads for an input the surface could not read, by the reader's code.
 * The reader writes its text in English.
 */
const GERMAN_UNREADABLE_INPUT: ReadonlyMap<string, string> = new Map([
  ["invalid_json", "Die Eingabe muss ein gültiges JSON-Objekt sein."],
  [
    "invalid_text",
    "Die Eingabe enthält ein NUL-Zeichen oder ein halbes Surrogatpaar, das sich nicht speichern lässt. Sende den Aufruf ohne es noch einmal."
  ]
]);

/** Localized refusal shared by operation calls and the composite Knowledge Base tools. */
export function unreadableInputMessage(
  input: NonNullable<OperationCallRuntime["unreadableInput"]>,
  locale: LocaleCode | undefined
): string {
  return locale === "de"
    ? (GERMAN_UNREADABLE_INPUT.get(input.code) ?? "Die Eingabe für diesen Aufruf ist nicht lesbar.")
    : input.message;
}
