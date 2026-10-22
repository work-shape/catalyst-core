// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";

// PR-382 M1: the page of a new skill said its create applied at once, though under an approval
// policy the reader's create files a request. The page now asks the instance about the id the
// typed name makes, as the create dialog asked of the name, and says who decides before the
// create.

afterEach(async () => {
  await unmountBuildPages();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const stored: BuildAsset = {
  id: "asset_skill",
  kind: "skill",
  name: "leave-policy",
  scope: { kind: "instance" },
  revision: 1,
  config: { name: "leave-policy", title: "Leave policy", description: "Leave", content: "#" },
  updatedAt: "2026-10-19T09:00:00.000Z"
};

/** Opens the list of skills, starts a new skill and answers the page it opens. */
async function newSkillPage(saveApproval?: { approverNames: string[] }): Promise<HTMLElement> {
  const asked: string[] = [];
  const page = await mountBuildPage(stored, "skills", () => undefined, [], {
    list: { opened: [] },
    skillEditing: true,
    checkName: async (_kind, name) => {
      asked.push(name);
      return { available: true, ...(saveApproval ? { saveApproval } : {}) };
    }
  });
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find((found) => found.textContent?.trim() === text);
  await vi.waitFor(() => expect(button("New skill")).toBeDefined(), { timeout: 5000 });
  await act(async () => button("New skill")?.click());
  // New opens the empty page of a new skill: the name typed there makes the id it asks about.
  const field = await vi.waitFor(
    () => {
      const label = [...document.querySelectorAll("label")].find((found) =>
        found.textContent?.startsWith("Title")
      );
      const id = label?.getAttribute("for");
      const found = id ? document.getElementById(id) : null;
      if (!(found instanceof HTMLInputElement)) throw new Error("no Title field yet");
      return found;
    },
    { timeout: 5000 }
  );
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(field, "Travel policy");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() => expect(asked).toContain("travel-policy"), { timeout: 5000 });
  await vi.waitFor(() => expect(button("Create skill")).toBeDefined(), { timeout: 5000 });
  return page;
}

describe("The page of a new skill", () => {
  it("names who approves before a create that would wait for an approval", async () => {
    const page = await newSkillPage({ approverNames: ["Mara Lindqvist"] });
    await vi.waitFor(
      () =>
        expect(page.textContent).toContain(
          "Saving sends a request. It takes effect once Mara Lindqvist approves it."
        ),
      { timeout: 5000 }
    );
    expect(page.textContent).not.toContain("Applies to new conversations immediately.");
  });

  it("says a create applies at once where the instance holds none", async () => {
    const page = await newSkillPage();
    await vi.waitFor(
      () => expect(page.textContent).toContain("Applies to new conversations immediately."),
      { timeout: 5000 }
    );
    expect(page.textContent).not.toContain("Saving sends a request");
  });
});
