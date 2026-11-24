import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Chip,
  ChipList,
  UiRoot,
  uiLabelsEn,
  type ChipListProps,
  type ChipProps
} from "@work-shape/catalyst-ui";

const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node));

const chip = (props: Omit<ChipProps, "children">, label: string, key?: number) =>
  createElement(Chip, { ...props, key, children: label });

const list = (props: Omit<ChipListProps, "children" | "label">, count: number) =>
  createElement(ChipList, {
    ...props,
    label: "Knowledge",
    children: Array.from({ length: count }, (_, index) =>
      chip({ tone: "quiet" }, `Chip ${String(index + 1)}`, index)
    )
  });

describe("a quiet Chip", () => {
  it("stands back: a soft fill in muted ink, without the border of a chip", () => {
    const quiet = render(chip({ tone: "quiet" }, "Handbook"));
    expect(quiet).toContain('data-tone="quiet"');
    expect(quiet).toContain("border-transparent");
    expect(quiet).toContain("text-muted-foreground");
    expect(render(chip({}, "Handbook"))).not.toContain("data-tone");
  });

  it("is a label and no control without a description", () => {
    const markup = render(
      chip({ tone: "quiet", accessibleLabel: "Knowledge: Handbook" }, "Handbook")
    );
    expect(markup).not.toContain("<button");
    expect(markup).toContain('<span class="sr-only">Knowledge: Handbook</span>');
    // The label is read once: what shows is hidden from assistive technology.
    expect(markup).toMatch(/aria-hidden="true"[^>]*>.*Handbook/u);
  });

  it("takes focus for its description and keeps the look of a label", () => {
    const markup = render(
      chip(
        { tone: "quiet", description: "Every product.", accessibleLabel: "Knowledge: Handbook" },
        "Handbook"
      )
    );
    expect(markup).toContain('<button type="button" aria-label="Knowledge: Handbook"');
    expect(markup).toContain("cursor-default");
    expect(markup).not.toContain("hover:bg-state-hover");
    // An empty description is none.
    expect(render(chip({ description: "" }, "Handbook"))).not.toContain("<button");
  });
});

describe("ChipList", () => {
  it("is a named list on one line, and nothing without chips", () => {
    const markup = render(list({}, 2));
    expect(markup).toContain('<ul aria-label="Knowledge"');
    expect(markup).toContain("flex-nowrap");
    expect(markup).not.toContain("flex-wrap");
    expect(markup.match(/<li/gu)).toHaveLength(2);
    expect(render(list({}, 0))).not.toContain("<ul");
  });

  it("shows every chip before it has measured its room", () => {
    const markup = render(list({ tone: "quiet" }, 12));
    expect(markup).toContain("Chip 12");
    expect(markup).not.toContain("+");
  });
});
