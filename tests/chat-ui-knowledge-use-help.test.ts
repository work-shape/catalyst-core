import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import { required } from "./support/assertions";
import { rightSentenceKeys } from "./support/chat-ui";

// ACCEPT-FIX-10 C3: in Neues Recht, the help under "Verwenden" on a Knowledge Base spoke of
// "Zeilen" and the "Datenspeicher" behind it, also for a Knowledge Base of documents.

describe("the help under the use right of a Knowledge Base", () => {
  const key = required(rightSentenceKeys["knowledge_base.use"]);

  it.each([
    { locale: "en" as const, said: "documents", never: [/\brows?\b/iu, /data store/iu] },
    { locale: "de" as const, said: "Dokumenten", never: [/Zeile/iu, /Datenspeicher/iu] }
  ])("speaks of documents and not of rows or a data store ($locale)", ({ locale, said, never }) => {
    const help = createTranslationContext(locale).t(key);
    expect(help).toContain(said);
    for (const word of never) expect(help).not.toMatch(word);
  });
});
