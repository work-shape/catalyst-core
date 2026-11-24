import { chatUiSources } from "./support/chat-ui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslationContext } from "./support/chat-ui/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("interface translations", () => {
  const en = createTranslationContext("en");
  const de = createTranslationContext("de");

  it("names the model-setting right in the locked-field hint", () => {
    const right = de.t("rights.actionAgentModelsManage");
    expect(de.t("userRightAgentModelsManage")).toBe(right);
    expect(de.t("build.modelSetByModelManagers")).toContain(right);
  });

  it("looks a message up in the chosen locale unless the client overrides it", () => {
    expect(en.t("cancel")).toBe("Cancel");
    expect(de.t("cancel")).toBe("Abbrechen");
    const labels = { resourcesCustomerData: { en: "Client records", de: "Datensätze" } };
    expect(createTranslationContext("de", labels).t("resourcesCustomerData")).toBe("Datensätze");
    expect(createTranslationContext("de", labels).t("cancel")).toBe("Abbrechen");
  });

  it("tells what publishing does without a pronoun that fits only some kinds", () => {
    // The dialog serves every kind: der Agent, die Wissensbasis, die App, der Workflow.
    // "die ihn nutzen" read wrong for a Wissensbasis (ACCEPT-2e).
    expect(de.t("build.publishDescription")).not.toMatch(/\b(ihn|sie|es)\b/u);
  });

  it("puts values into their placeholders as text, and leaves one without a value as written", () => {
    expect(en.t("attachmentsShowMore", { count: 3 })).toBe("+ 3 more");
    expect(en.t("attachmentsShowMore", { other: 1 })).toBe("+ {count} more");
    expect(en.t("accountMenuLabel", { label: "<b>$&</b>" })).toBe("<b>$&</b> account");
  });
});

// The compiler checks the real area files with every type check. These sources show that the
// same declarations reject an incomplete locale and a key that two areas share.
describe("translation area types", { timeout: 60_000 }, () => {
  const areas = fileURLToPath(chatUiSources.i18n);
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

  // The package's own compiler options: a config that cannot be read would leave the fixtures
  // without the declarations their diagnostics name, so the test stops instead.
  const config = fileURLToPath(new URL("../packages/chat-ui/tsconfig.json", import.meta.url));
  const read = ts.readConfigFile(config, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  }
  const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config));
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

  it("accepts an area with the same keys in every locale, and combines areas with separate keys", () => {
    expect(errorsOf("complete")).toEqual([]);
    expect(errorsOf("separateAreas")).toEqual([]);
  });

  it("rejects a key that one locale lacks", () => {
    expect(errorsOf("missingKey").join("\n")).toContain("Property 'second' is missing");
    expect(errorsOf("extraKey").join("\n")).toContain("Property 'second' is missing");
  });

  it("rejects an area without one of the supported locales", () => {
    expect(errorsOf("missingLocale").join("\n")).toContain("Property 'de' is missing");
  });

  it("rejects a key that two areas declare, wherever the areas stand in the list", () => {
    expect(errorsOf("sharedKey").join("\n")).toContain(`shared: "first"`);
    expect(errorsOf("sharedKeyLater").join("\n")).toContain(`shared: "first"`);
  });

  it("has no key of an area that was not combined, so no area joins unchecked", () => {
    expect(errorsOf("uncombinedKey").join("\n")).toContain("Property 'second' does not exist");
  });
});
