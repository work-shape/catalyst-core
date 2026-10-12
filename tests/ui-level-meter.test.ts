import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LevelMeter, type LevelMeterProps } from "@vivd-catalyst/ui";

// LevelMeter is a level on a short scale of named steps. Every test here fails without the
// component: the library did not export it.

const render = (props: Partial<LevelMeterProps>) =>
  renderToStaticMarkup(
    createElement(LevelMeter, {
      label: "Usage consumption",
      level: 3,
      valueLabel: "Moderate",
      ...props
    })
  );
const meter = (markup: string) => /<div role="meter"[^>]*>/u.exec(markup)?.[0] ?? "";
const segments = (markup: string) =>
  [...markup.matchAll(/<span( data-filled="")? class="([^"]*)"><\/span>/gu)].map((match) => ({
    filled: match[1] !== undefined,
    classes: match[2]?.split(" ") ?? []
  }));
const fills = (markup: string) =>
  segments(markup)
    .filter((segment) => segment.filled)
    .map((segment) => segment.classes.find((name) => name.startsWith("bg-")));

describe("LevelMeter", () => {
  it("is a named meter of six steps that says its level in words, in the meter and beside it", () => {
    const markup = render({});

    expect(meter(markup)).toContain('aria-label="Usage consumption"');
    expect(meter(markup)).toContain('aria-valuemin="1"');
    expect(meter(markup)).toContain('aria-valuemax="6"');
    expect(meter(markup)).toContain('aria-valuenow="3"');
    expect(meter(markup)).toContain('aria-valuetext="Moderate"');
    expect(markup).toContain(">Usage consumption</span>");
    expect(markup).toContain(">Moderate</span>");
    expect(segments(markup).map((segment) => segment.filled)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false
    ]);
  });

  it("fills with the text colour unless a scale is asked for", () => {
    expect(fills(render({ level: 2 }))).toEqual(["bg-foreground", "bg-foreground"]);
    expect(segments(render({ level: 2 }))[2]?.classes).toContain("bg-state-pressed");
  });

  it("gives every filled step of a spectrum meter the colour of its level", () => {
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(fills(render({ level, scale: "spectrum" }))).toEqual(
        Array.from({ length: level }, () => `bg-level-${level}`)
      );
    }
  });

  it("spreads a shorter scale over the six colours, ending on the last", () => {
    const top = (level: number) => fills(render({ level, steps: 4, scale: "spectrum" }))[0];

    expect([1, 2, 3, 4].map(top)).toEqual(["bg-level-1", "bg-level-3", "bg-level-4", "bg-level-6"]);
    expect(segments(render({ level: 4, steps: 4 }))).toHaveLength(4);
  });

  it("keeps a level outside the scale on its nearest end", () => {
    expect(meter(render({ level: 0 }))).toContain('aria-valuenow="1"');
    expect(meter(render({ level: 9 }))).toContain('aria-valuenow="6"');
    expect(fills(render({ level: 9 }))).toHaveLength(6);
  });
});
