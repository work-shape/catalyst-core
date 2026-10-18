import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { demoCompany } from "@work-shape/catalyst-demo/seed";

// ACCEPT-1c: asked for a personal reminder, the demo's agent named it `hr-weekly-document-reminder`.
// The agent reads each registered name prefix by its display name (platform context), and the
// demo called its HR prefix "Personal", the word the interface uses for a person's own scope.
// No prefix the demo registers may be named like that scope in either language.

/** Every prefix the demo's company registers, with the name people and the agent read. */
const prefixes = Object.values(demoCompany)
  .flatMap((value: unknown) => (Array.isArray(value) ? value : []))
  .flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "prefix" in entry &&
    "displayName" in entry &&
    typeof entry.prefix === "string" &&
    typeof entry.displayName === "string"
      ? [{ prefix: entry.prefix, displayName: entry.displayName }]
      : []
  );

describe("the name prefixes of the demo", () => {
  it("are never named like a person's own scope", () => {
    const scope = [createTranslationContext("en"), createTranslationContext("de")].map(({ t }) =>
      t("build.scopePersonal").toLocaleLowerCase()
    );
    expect(prefixes.map(({ prefix }) => prefix)).toContain("hr-");
    for (const { displayName } of prefixes) {
      expect(scope).not.toContain(displayName.trim().toLocaleLowerCase());
    }
  });

  it("name the HR prefix for what it holds", () => {
    expect(prefixes.find(({ prefix }) => prefix === "hr-")?.displayName).toMatch(/HR/u);
  });
});
