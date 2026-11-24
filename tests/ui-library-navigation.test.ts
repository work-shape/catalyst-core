import { createElement, Fragment, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CountBadge,
  docsAddress,
  DocsAddressProvider,
  DocsLink,
  type PageProps,
  SaveBar,
  type SaveBarProps,
  SubRail,
  type SubRailGroup,
  type SubRailProps,
  UiRoot,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

const link = (href: string, label?: string) => createElement("a", { href }, label);

describe("navigation components", () => {
  it("caps a count at 99+", () => {
    expect(render(createElement(CountBadge, { count: 99 }))).toContain(">99<");
    expect(render(createElement(CountBadge, { count: 100 }))).toContain(">99+<");
  });

  it("folds a collapsible sub-rail group until one of its items is open, and lists it whole in the select", () => {
    const rail = (value: string) =>
      render(
        createElement(SubRail, {
          label: "Settings",
          value,
          onValueChange: () => undefined,
          groups: [
            {
              id: "instance",
              label: "Instance",
              items: [{ id: "users", label: "Users", link: link("/users") }]
            },
            {
              id: "system",
              label: "System",
              collapsible: true,
              items: [
                { id: "jobs", label: "Jobs", link: link("/jobs") },
                { id: "modules", label: "Modules", link: link("/modules") }
              ]
            }
          ]
        })
      );

    const folded = rail("users");
    expect(folded).not.toMatch(/<a[^>]*href="\/jobs"/u);
    expect(folded).toMatch(/<optgroup label="System"><option value="jobs">Jobs<\/option>/u);

    const open = rail("jobs");
    expect(open).toMatch(/<a[^>]*href="\/jobs"[^>]*aria-current="page"/u);
    expect(open).toMatch(/<a[^>]*href="\/modules"/u);
  });

  it("gives the save bar a discard that never submits, and hides the bar while clean", () => {
    const bar = (props: Partial<SaveBarProps>) =>
      render(
        createElement(SaveBar, {
          label: "Save",
          changes: "3 changes",
          discardLabel: "Discard",
          onDiscard: () => undefined,
          ...props
        })
      );

    const dirty = bar({ whenClean: "hidden", dirty: true });
    expect(dirty).toMatch(
      /<button[^>]*type="submit"[\s\S]*<button[^>]*type="button"[^>]*>Discard/u
    );
    expect(dirty).not.toMatch(/<button[^>]*disabled=""[^>]*>Discard/u);
    expect(bar({ whenClean: "hidden", dirty: false })).toBe(render(createElement(Fragment)));
    // A save under way keeps the bar, and holds discard.
    expect(bar({ whenClean: "hidden", saving: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Discard/u
    );
    expect(bar({ dirty: false })).toContain("3 changes");
    expect(bar({ onDiscard: undefined })).not.toContain("Discard");
  });

  it("links into the documentation from the instance's docs address, in a new tab", () => {
    const docs = createElement(DocsLink, {
      path: "/operate/how-rights-work/#building-and-using",
      accessibleName: "Learn more about workspaces, opens in a new tab",
      children: "Learn more"
    });
    const at = (address: string | undefined) =>
      render(createElement(DocsAddressProvider, { address, children: docs }));

    expect(at("https://docs.workshape.ai/catalyst")).toMatch(
      /<a href="https:\/\/docs\.workshape\.ai\/catalyst\/operate\/how-rights-work\/#building-and-using" target="_blank" rel="noopener noreferrer"/u
    );
    // The docs address keeps its own path, with or without a slash at its end.
    expect(at("https://docs.workshape.ai/catalyst/")).toContain(
      'href="https://docs.workshape.ai/catalyst/operate/how-rights-work/#building-and-using"'
    );
    expect(docsAddress("https://docs.example.com", "operate/x/")).toBe(
      "https://docs.example.com/operate/x/"
    );
    // An instance without a docs address renders no link.
    expect(at(undefined)).not.toContain("<a");
    expect(docsAddress(undefined, "/operate/")).toBeUndefined();
    expect(docsAddress("", "/operate/")).toBeUndefined();
  });
});

/** Whether a value of `Candidate` may be handed where `Props` are asked for. */
type Fits<Candidate, Props> = [Candidate] extends [Props] ? true : false;

describe("a sub-rail only opens pages", () => {
  it("refuses, by its types, to scroll within a page or to share a page with an outline", () => {
    // Each line fails the type check of the tests once the library accepts what it names.
    // What the editors handed a sub-rail that followed the scroll: no open route.
    const sectionsOnly: Fits<{ label: string; groups: SubRailGroup[] }, SubRailProps> = false;
    const hasMode: Fits<"mode", keyof SubRailProps> = false;
    // The left column navigates, the right outline scrolls: a page has one of them.
    const both: Fits<{ subRail: ReactElement; outline: ReactElement }, PageProps> = false;
    const railOnly: Fits<{ subRail: ReactElement }, PageProps> = true;
    const outlineOnly: Fits<{ outline: ReactElement }, PageProps> = true;
    expect([sectionsOnly, hasMode, both, railOnly, outlineOnly]).toEqual([
      false,
      false,
      false,
      true,
      true
    ]);
  });
});
