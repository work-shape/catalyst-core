import { describe, expect, it } from "vitest";
import { railSections, shownRailSections } from "./support/chat-ui";

// Projects has no section row (Felix, 2026-10-29): the group "Projects" above "Recent" is its
// only place in the rail.
describe("the section rows", () => {
  it("hold no Projects row", () => {
    expect(railSections.map((row) => row.id)).not.toContain("projects");
    expect(
      shownRailSections(railSections, {
        agents: true,
        apps: true,
        workflows: true,
        scheduled: true,
        inbox: { toDecide: 0 }
      }).map((row) => row.view)
    ).not.toContain("projects");
  });
});
