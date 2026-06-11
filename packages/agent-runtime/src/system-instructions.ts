import type { LocaleCode } from "@vivd-catalyst/core";

export function createSystemInstructions(
  instructions: string,
  toolCount: number,
  locale?: LocaleCode
): string {
  const sections = [instructions];

  const languageInstruction = createLanguageInstruction(locale);
  if (languageInstruction) {
    sections.push(languageInstruction);
  }

  if (toolCount > 0) {
    sections.push(
      "You have access to configured tools. Use them automatically when they are relevant. Do not ask the user to type debug commands or tool invocation syntax."
    );
  }

  return sections.join("\n\n");
}

function createLanguageInstruction(locale: LocaleCode | undefined): string | undefined {
  if (locale === "de") {
    return "Respond in German unless the user explicitly asks for another language.";
  }
  if (locale === "en") {
    return "Respond in English unless the user explicitly asks for another language.";
  }
  return undefined;
}
