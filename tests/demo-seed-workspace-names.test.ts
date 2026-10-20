import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { demoCompany } from "@work-shape/catalyst-demo/seed";

// ACCEPT-1c: asked for a personal reminder, the demo's agent named it `hr-weekly-document-reminder`.
// The agent reads the places it may build in by their names (platform context), and the demo
// called its HR place "Personal", the word the interface uses for a person's own scope. No
// Shared Workspace the demo seeds may be named like that scope in either language.

/** Every Shared Workspace the demo's company seeds, by the name people and the agent read. */
const workspaceNames = Object.values(demoCompany).flatMap((value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  "members" in value &&
  typeof value.name === "string" &&
  Array.isArray(value.members)
    ? [value.name]
    : []
);

describe("the workspaces of the demo", () => {
  it("are never named like a person's own scope", () => {
    const scope = [createTranslationContext("en"), createTranslationContext("de")].map(({ t }) =>
      t("build.scopePersonal").toLocaleLowerCase()
    );
    expect(workspaceNames).toContain(demoCompany.hrWorkspace.name);
    for (const name of workspaceNames) {
      expect(scope).not.toContain(name.trim().toLocaleLowerCase());
    }
  });

  it("name the HR workspace for what it holds", () => {
    expect(demoCompany.hrWorkspace.name).toMatch(/HR/u);
  });
});
