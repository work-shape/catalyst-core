import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("interface translations", () => {
  const en = createTranslationContext("en");
  const de = createTranslationContext("de");

  it("looks a message up in the chosen locale", () => {
    expect(en.locale).toBe("en");
    expect(en.t("cancel")).toBe("Cancel");
    expect(de.locale).toBe("de");
    expect(de.t("cancel")).toBe("Abbrechen");
  });

  it("finds keys of every area through the one lookup", () => {
    expect(de.t("closeSidebar")).toBe("Seitenleiste schließen");
    expect(de.t("attachmentRemove")).toBe("Anhang entfernen");
    expect(de.t("settings.apiAccess")).toBe("API-Zugang");
    expect(en.t("genericWelcome")).toBe("How can I help?");
  });

  it("names each locale in the active language", () => {
    expect(en.localeName("de")).toBe("Deutsch");
    expect(en.localeName("en")).toBe("English");
    expect(de.localeName("en")).toBe("English");
  });

  it("reads the settings pages in both languages", () => {
    expect(en.t("settings.auditEmpty")).toBe("No audit events in this range.");
    expect(de.t("settings.auditEmpty")).toBe("Keine Audit-Ereignisse in diesem Zeitraum.");
    expect([
      de.t("settings.time"),
      de.t("settings.auditEvent"),
      de.t("settings.status"),
      de.t("settings.auditActor"),
      de.t("settings.auditSubject"),
      de.t("settings.auditReason")
    ]).toEqual(["Zeit", "Ereignis", "Status", "Akteur", "Betrifft", "Grund"]);
    expect(en.t("settings.paginationRange", { from: 1, to: 10, total: 23 })).toBe("1-10 of 23");
    expect(de.t("settings.paginationRange", { from: 1, to: 10, total: 23 })).toBe("1–10 von 23");
    expect(en.t("settings.usageBudgetUsedLabel", { budget: "Daily budget" })).toBe(
      "Daily budget used"
    );
    expect(de.t("settings.usageBudgetRemainingToday", { amount: "40,00 €" })).toBe(
      "Heute noch 40,00 € übrig."
    );
    expect(de.t("settings.copyValue", { label: "Server-URL" })).toBe("Server-URL kopieren");
  });

  it("says when the open conversation is deleted, and what keeps it only where that is true", () => {
    const hint = (context: typeof en) =>
      context.t("conversationExpiresOn", {
        date: context.locale === "de" ? "Dienstag, 13. Oktober" : "Tuesday, October 13"
      });
    expect(en.t("conversationRetentionNotice", { hint: hint(en) })).toBe(
      "Will be deleted automatically on Tuesday, October 13."
    );
    expect(en.t("conversationRetentionNoticeKeptByMessage", { hint: hint(en) })).toBe(
      "Will be deleted automatically on Tuesday, October 13. A new message keeps this conversation."
    );
    expect(de.t("conversationRetentionNotice", { hint: hint(de) })).toBe(
      "Wird am Dienstag, 13. Oktober automatisch gelöscht."
    );
    expect(de.t("conversationRetentionNoticeKeptByMessage", { hint: hint(de) })).toBe(
      "Wird am Dienstag, 13. Oktober automatisch gelöscht. Mit einer neuen Nachricht bleibt diese Unterhaltung erhalten."
    );
  });

  it("puts values into their placeholders", () => {
    expect(en.t("attachmentsShowMore", { count: 3 })).toBe("+ 3 more");
    expect(de.t("attachmentsSummary", { count: 2, size: "4 MB" })).toBe("2 Dateien · 4 MB");
    expect(en.t("accountMenuLabel", { label: "Ada" })).toBe("Ada account");
  });

  it("names a spreadsheet object without a preview in the chosen locale", () => {
    const sentence = (context: typeof en) =>
      context.t("spreadsheetVisualUnavailable", {
        objectType: context.t("spreadsheetObjectLinkedChart")
      });
    expect(sentence(en)).toBe("Linked chart preview unavailable");
    expect(sentence(de)).toBe("Verknüpftes Diagramm: Vorschau nicht verfügbar");
    expect(de.t("spreadsheetObjectImage", { format: "EMF" })).toBe("EMF-Bild");
  });

  it("leaves a placeholder without a value as written", () => {
    expect(en.t("attachmentsShowMore")).toBe("+ {count} more");
    expect(en.t("attachmentsShowMore", {})).toBe("+ {count} more");
    expect(en.t("attachmentsShowMore", { other: 1 })).toBe("+ {count} more");
  });

  it("inserts a value as text, whatever it contains", () => {
    expect(en.t("accountMenuLabel", { label: "<b>$&</b>" })).toBe("<b>$&</b> account");
  });
});

// The compiler checks the real area files with every type check. These sources show that the
// same declarations reject an incomplete locale and a key that two areas share.
describe("translation area types", { timeout: 60_000 }, () => {
  const areas = fileURLToPath(new URL("../packages/chat-ui/src/i18n", import.meta.url));
  const sources: Record<string, string> = {
    complete: `import { defineTranslations } from "./translation-area";
export const area = defineTranslations({
  en: { first: "First", second: "Second" },
  de: { first: "Erstes", second: "Zweites" }
});
`,
    missingKey: `import { defineTranslations } from "./translation-area";
export const area = defineTranslations({
  en: { first: "First", second: "Second" },
  de: { first: "Erstes" }
});
`,
    extraKey: `import { defineTranslations } from "./translation-area";
export const area = defineTranslations({
  en: { first: "First" },
  de: { first: "Erstes", second: "Zweites" }
});
`,
    missingLocale: `import { defineTranslations } from "./translation-area";
export const area = defineTranslations({ en: { first: "First" } });
`,
    separateAreas: `import { combineTranslations, defineTranslations } from "./translation-area";
const one = defineTranslations({ en: { first: "First" }, de: { first: "Erstes" } });
const two = defineTranslations({ en: { second: "Second" }, de: { second: "Zweites" } });
const { messages } = combineTranslations(one).and(two);
export const both: string = messages.de.first + messages.de.second;
`,
    sharedKey: `import { combineTranslations, defineTranslations } from "./translation-area";
const one = defineTranslations({ en: { first: "First" }, de: { first: "Erstes" } });
const two = defineTranslations({ en: { first: "Again" }, de: { first: "Nochmal" } });
export const { messages } = combineTranslations(one).and(two);
`,
    sharedKeyLater: `import { combineTranslations, defineTranslations } from "./translation-area";
const one = defineTranslations({ en: { first: "First" }, de: { first: "Erstes" } });
const two = defineTranslations({ en: { second: "Second" }, de: { second: "Zweites" } });
const three = defineTranslations({
  en: { third: "Third", first: "Again" },
  de: { third: "Drittes", first: "Nochmal" }
});
export const { messages } = combineTranslations(one).and(two).and(three);
`,
    uncombinedKey: `import { combineTranslations, defineTranslations } from "./translation-area";
const one = defineTranslations({ en: { first: "First" }, de: { first: "Erstes" } });
const two = defineTranslations({ en: { second: "Second" }, de: { second: "Zweites" } });
const { messages } = combineTranslations(one);
export const missing: string = messages.de.second;
export const unused = two;
`
  };

  const config = join(dirname(dirname(areas)), "tsconfig.json");
  const { options } = ts.parseJsonConfigFileContent(
    ts.readConfigFile(config, ts.sys.readFile).config,
    ts.sys,
    dirname(config)
  );
  const pathOf = (name: string) => join(areas, `${name}.fixture.ts`);
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const fixture = (path: string) =>
    Object.keys(sources).find((name) => pathOf(name) === path) ?? "";
  host.readFile = (path) => sources[fixture(path)] ?? readFile(path);
  host.fileExists = (path) => fixture(path) !== "" || fileExists(path);
  const program = ts.createProgram(Object.keys(sources).map(pathOf), options, host);

  const errorsOf = (name: string) =>
    ts
      .getPreEmitDiagnostics(program, program.getSourceFile(pathOf(name)))
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

  it("accepts an area with the same keys in every locale", () => {
    expect(errorsOf("complete")).toEqual([]);
  });

  it("rejects a key that one locale lacks", () => {
    expect(errorsOf("missingKey").join("\n")).toContain("Property 'second' is missing");
    expect(errorsOf("extraKey").join("\n")).toContain("Property 'second' is missing");
  });

  it("rejects an area without one of the supported locales", () => {
    expect(errorsOf("missingLocale").join("\n")).toContain("Property 'de' is missing");
  });

  it("combines areas with separate keys", () => {
    expect(errorsOf("separateAreas")).toEqual([]);
  });

  it("rejects a key that two areas declare, wherever the areas stand in the list", () => {
    expect(errorsOf("sharedKey").join("\n")).toContain(`shared: "first"`);
    expect(errorsOf("sharedKeyLater").join("\n")).toContain(`shared: "first"`);
  });

  it("has no key of an area that was not combined, so no area joins unchecked", () => {
    expect(errorsOf("uncombinedKey").join("\n")).toContain("Property 'second' does not exist");
  });
});
