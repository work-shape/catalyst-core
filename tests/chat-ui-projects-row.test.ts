import { describe, expect, it } from "vitest";
import { railSections, shownRailSections } from "./support/chat-ui";

// PRJ-1: the Projects row stands first under New chat while the instance's module is on, and
// is absent while it is off.
describe("the Projects row", () => {
  it("shows while the module is on and the session has workspaces", () => {
    expect(shownRailSections(railSections, { projects: true }).map((row) => row.id)).toEqual([
      "projects"
    ]);
    expect(shownRailSections(railSections, { projects: true })[0]).toMatchObject({
      view: "projects",
      icon: "project"
    });
  });

  it("is absent while the module is off", () => {
    expect(shownRailSections(railSections, {}).map((row) => row.id)).not.toContain("projects");
    expect(shownRailSections(railSections, { projects: false }).map((row) => row.id)).not.toContain(
      "projects"
    );
  });
});
