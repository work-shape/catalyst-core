import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress, type ProgressProps } from "@vivd-catalyst/ui";

// Progress is a bar for "so many of so many". Every test here fails without the component:
// the library did not export it.

const render = (props: Partial<ProgressProps>) =>
  renderToStaticMarkup(createElement(Progress, { label: "Entries done", ...props }));
const bar = (markup: string) => /<div role="progressbar"[^>]*>/u.exec(markup)?.[0] ?? "";
const parts = (markup: string) =>
  [...markup.matchAll(/<span data-tone="(\w+)" class="([^"]*)" style="width:([\d.]+)%">/gu)].map(
    (match) => ({ tone: match[1], classes: match[2]?.split(" ") ?? [], width: Number(match[3]) })
  );

describe("Progress", () => {
  it("is a named progress bar that reports the amount, its range and the amount in words", () => {
    const markup = render({ value: 412, max: 600, valueLabel: "412 of 600" });

    expect(bar(markup)).toContain('aria-label="Entries done"');
    expect(bar(markup)).toContain('aria-valuemin="0"');
    expect(bar(markup)).toContain('aria-valuemax="600"');
    expect(bar(markup)).toContain('aria-valuenow="412"');
    expect(bar(markup)).toContain('aria-valuetext="412 of 600"');
    expect(parts(markup).map((part) => part.width)).toEqual([(412 / 600) * 100]);
    // The words stand after the bar once: a screen reader has them from the bar already.
    expect(markup).toMatch(/<span aria-hidden="true" class="[^"]*">412 of 600<\/span><\/div>$/u);
  });

  it("shows no words without a value label, and counts in percent without a maximum", () => {
    const markup = render({ value: 40 });

    expect(bar(markup)).toContain('aria-valuemax="100"');
    expect(bar(markup)).not.toContain("aria-valuetext");
    expect(markup).not.toContain('aria-hidden="true"');
    expect(parts(markup).map((part) => part.width)).toEqual([40]);
  });

  it.each([
    ["neutral", "bg-foreground"],
    ["success", "bg-success"],
    ["warning", "bg-warning"],
    ["danger", "bg-destructive"]
  ] as const)("fills a %s bar from the tone's token", (tone, fill) => {
    expect(parts(render({ value: 50, tone }))[0]?.classes).toContain(fill);
  });

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

  it("says that the amount is unknown by reporting none", () => {
    const markup = render({});

    expect(bar(markup)).not.toContain("aria-valuenow");
    expect(parts(markup)).toEqual([]);
    expect(markup).toContain('data-indeterminate=""');
  });

  it("moves nothing under reduced motion, in either form", () => {
    expect(parts(render({ value: 50 }))[0]?.classes).toEqual(
      expect.arrayContaining(["transition-[width]", "motion-reduce:transition-none"])
    );
    expect(render({})).toMatch(
      /<span data-indeterminate="" class="[^"]*animate-pulse[^"]*motion-reduce:animate-none/u
    );
  });
});
