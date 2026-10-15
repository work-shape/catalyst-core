import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Step,
  Steps,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn,
  type StepProps,
  type StepState,
  type UiLabels
} from "@work-shape/catalyst-ui";

// Steps is an ordered list of steps joined by a line. Every test here fails without the
// components: the library did not export them.

const inRoot = (node: ReactNode, labels = uiLabelsEn) =>
  renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, node));
const list = (...steps: ReactNode[]) => createElement(Steps, { label: "What it does" }, ...steps);
const step = (props: StepProps, labels = uiLabelsEn) =>
  inRoot(list(createElement(Step, { key: "step", ...props })), labels);
const slot = (markup: string, name: string) =>
  new RegExp(`<[a-z]+[^>]*data-slot="${name}"[^>]*>`, "u").exec(markup)?.[0] ?? "";
const classesOf = (tag: string) => /\sclass="([^"]*)"/u.exec(tag)?.[1]?.split(" ") ?? [];

describe("Steps", () => {
  it("is a named ordered list with one item per step, in the order given", () => {
    const markup = renderToStaticMarkup(
      list(
        createElement(Step, { key: 1, marker: 1, title: "Load" }),
        createElement(Step, { key: 2, marker: 2, title: "Check" }),
        createElement(Step, { key: 3, marker: 3, title: "Save" })
      )
    );

    expect(markup).toMatch(/^<ol role="list" aria-label="What it does"/u);
    expect(markup.match(/<li\b/gu)).toHaveLength(3);
    expect([...markup.matchAll(/data-slot="step-title"[^>]*>([^<]*)</gu)].map((m) => m[1])).toEqual(
      ["Load", "Check", "Save"]
    );
    // A step that is only described needs no label of the library, so no UiRoot.
    expect(markup).not.toContain("sr-only");
  });

  it("puts a nested list inside its step, set in by a bar and boxed where there is room", () => {
    const inner = createElement(
      Steps,
      { nested: true, label: "For each entry" },
      createElement(Step, { marker: "a", title: "Inner" })
    );
    const markup = renderToStaticMarkup(list(createElement(Step, { key: 1, marker: 1 }, inner)));
    const nested = /<ol role="list" aria-label="For each entry"[^>]*>/u.exec(markup)?.[0] ?? "";

    expect(markup).toMatch(
      /<div data-slot="step-body"[^>]*><ol role="list" aria-label="For each entry" data-nested=""/u
    );
    expect(classesOf(nested)).toEqual(
      expect.arrayContaining(["border-l-2", "pl-3", "@lg:border", "@lg:rounded-md"])
    );
    // The outer list is what the box measures its room against.
    expect(classesOf(/^<ol[^>]*>/u.exec(markup)?.[0] ?? "")).toContain("@container");
    expect(classesOf(nested)).not.toContain("@container");
  });
});

describe("Step", () => {
  it("shows its parts in reading order: marker, eyebrow, badge, time, title, sentence, note", () => {
    const markup = step({
      marker: 2,
      eyebrow: "Reads data",
      badge: "BADGE",
      meta: "4 s",
      title: "Load customers",
      description: "Fetches the list.",
      note: "Runs the same way every time."
    });
    const order = [">2<", ">Reads data<", ">BADGE<", ">4 s<", ">Load customers<"];
    const positions = [...order, ">Fetches the list.<", ">Runs the same way every time.<"].map(
      (text) => markup.indexOf(text)
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(markup).not.toContain("<button");
  });

  const stateRows: readonly [StepState, string, keyof UiLabels][] = [
    ["queued", "neutral", "stateQueued"],
    ["running", "info", "stateRunning"],
    ["waiting", "neutral", "stateWaiting"],
    ["done", "success", "stateDone"],
    ["failed", "danger", "stateFailed"],
    ["cancelled", "neutral", "stateCancelled"],
    ["limit_reached", "danger", "stateLimitReached"]
  ];

  it.each(stateRows)(
    "marks a %s step in the %s tone and says the state in words",
    (state, tone, label) => {
      const markup = step({ state, title: "Load" }, uiLabelsDe);
      const marker = slot(markup, "step-marker");

      expect(markup).toContain(`data-step-state="${state}"`);
      expect(marker).toContain(`data-tone="${tone}"`);
      expect(markup).toContain(`<span class="sr-only">${uiLabelsDe[label]}</span>`);
      // The line to the next step takes the tone too.
      expect(classesOf(slot(markup, "step-line"))).toContain(
        tone === "neutral" ? "bg-border" : `bg-${tone === "danger" ? "destructive" : tone}-border`
      );
    }
  );

  it("lets the text of a step that was not reached recede, and of no other state", () => {
    const titleClasses = (state: StepState) =>
      classesOf(slot(step({ state, title: "Load" }), "step-title"));

    expect(titleClasses("queued")).toContain("text-muted-foreground");
    for (const [state] of stateRows.filter(([name]) => name !== "queued")) {
      expect(titleClasses(state)).toContain("text-foreground");
    }
    expect(classesOf(slot(step({ muted: true, title: "Load" }), "step-title"))).toContain(
      "text-muted-foreground"
    );
  });

  it("takes a marker and a tone of its own over the state's", () => {
    const markup = step({ state: "done", tone: "warning", marker: "!", title: "Load" });

    expect(markup).toMatch(
      /<span data-slot="step-marker" data-tone="warning"[^>]*>!<span class="sr-only">Done<\/span><\/span>/u
    );
  });

  it("refuses a state outside a UiRoot, which holds the words for it", () => {
    expect(() =>
      renderToStaticMarkup(list(createElement(Step, { key: 1, state: "done" })))
    ).toThrow(/Step must be rendered inside UiRoot/u);
  });

  it("shows its children always unless it unfolds", () => {
    expect(step({ title: "Load", children: "BODY" })).toMatch(
      /<div data-slot="step-body"[^>]*>BODY<\/div>/u
    );
    expect(step({ title: "Load" })).not.toContain("step-body");
  });

  it("unfolds through a button that names the step and says whether it is open", () => {
    const closed = step({ expandable: true, eyebrow: "Script", title: "Load", children: "BODY" });
    const open = step({
      expandable: true,
      defaultExpanded: true,
      eyebrow: createElement("a", { href: "/source" }, "Source"),
      title: "Load",
      children: "BODY"
    });
    const button = (markup: string) => /<button[^>]*>[\s\S]*?<\/button>/u.exec(markup)?.[0] ?? "";
    const controls = /aria-controls="([^"]+)"/u.exec(button(open))?.[1];

    expect(button(closed)).toMatch(/^<button type="button" aria-expanded="false"/u);
    expect(button(closed)).toContain(">Load<");
    expect(closed).not.toContain("BODY");
    expect(button(open)).toContain('aria-expanded="true"');
    expect(open).toMatch(new RegExp(`<div[^>]*id="${controls}"[^>]*>BODY</div>`, "u"));
    // A link in the eyebrow stays outside the button: a control holds no second control.
    expect(button(open)).not.toContain("<a ");
    expect(open.indexOf('<a href="/source"')).toBeLessThan(open.indexOf("<button"));
  });

  it("follows the caller's expanded state when it is given one", () => {
    const markup = step({ expandable: true, expanded: true, title: "Load", children: "BODY" });

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("BODY");
  });

  it("names the button of a step without a title by what it does", () => {
    const named = (expanded: boolean) =>
      step({ expandable: true, expanded, eyebrow: "For each entry", children: "BODY" }, uiLabelsDe);

    expect(named(false)).toContain(`<span class="sr-only">${uiLabelsDe.expand}</span>`);
    expect(named(true)).toContain(`<span class="sr-only">${uiLabelsDe.collapse}</span>`);
  });
});
