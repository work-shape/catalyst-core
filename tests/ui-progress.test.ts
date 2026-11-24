import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LevelMeter,
  Progress,
  serviceInitial,
  type LevelMeterProps,
  type ProgressProps
} from "@work-shape/catalyst-ui";

// The arithmetic of the library's small measures: Progress, LevelMeter and a service's initial.

describe("Progress", () => {
  const render = (props: Partial<ProgressProps>) =>
    renderToStaticMarkup(createElement(Progress, { label: "Entries done", ...props }));
  const bar = (markup: string) => /<div role="progressbar"[^>]*>/u.exec(markup)?.[0] ?? "";
  const parts = (markup: string) =>
    [...markup.matchAll(/<span data-tone="(\w+)" class="[^"]*" style="width:([\d.]+)%">/gu)].map(
      (match) => ({ tone: match[1], width: Number(match[2]) })
    );

  it("draws several shares in one bar, in their order, and reports their sum", () => {
    const markup = render({
      max: 600,
      parts: [
        { value: 210, tone: "success" },
        { value: 2, tone: "danger" }
      ]
    });

    expect(parts(markup).map((part) => [part.tone, part.width])).toEqual([
      ["success", 35],
      ["danger", (2 / 600) * 100]
    ]);
    expect(bar(markup)).toContain('aria-valuenow="212"');
  });

  it("never draws past the end of the bar or before its start", () => {
    const over = render({
      max: 10,
      parts: [
        { value: 8, tone: "success" },
        { value: 8, tone: "danger" },
        { value: -3, tone: "warning" }
      ]
    });

    expect(parts(over).map((part) => part.width)).toEqual([80, 20, 0]);
    expect(bar(over)).toContain('aria-valuenow="10"');
    expect(parts(render({ value: 5, max: 0 })).map((part) => part.width)).toEqual([0]);
  });
});

describe("LevelMeter", () => {
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
  const fills = (markup: string) =>
    [...markup.matchAll(/<span data-filled="" class="([^"]*)"><\/span>/gu)].map((match) =>
      (match[1] ?? "").split(" ").find((name) => name.startsWith("bg-"))
    );

  it("spreads a shorter scale over the six colours, ending on the last", () => {
    const top = (level: number) => fills(render({ level, steps: 4, scale: "spectrum" }))[0];

    expect([1, 2, 3, 4].map(top)).toEqual(["bg-level-1", "bg-level-3", "bg-level-4", "bg-level-6"]);
  });

  it("keeps a level outside the scale on its nearest end", () => {
    expect(meter(render({ level: 0 }))).toContain('aria-valuenow="1"');
    expect(meter(render({ level: 9 }))).toContain('aria-valuenow="6"');
    expect(fills(render({ level: 9 }))).toHaveLength(6);
  });
});

describe("serviceInitial", () => {
  it("takes the first letter or digit of the name", () => {
    expect(serviceInitial("  exampledata")).toBe("E");
    expect(serviceInitial("ödland")).toBe("Ö");
    expect(serviceInitial("(1&1)")).toBe("1");
    expect(serviceInitial("—")).toBe("");
  });
});
