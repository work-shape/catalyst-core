import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Step, Steps, UiRoot, uiLabelsEn, type StepProps } from "@work-shape/catalyst-ui";

const step = (props: StepProps) =>
  renderToStaticMarkup(
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(
        Steps,
        { label: "What it does" },
        createElement(Step, { key: "step", ...props })
      )
    )
  );

describe("Step that unfolds", () => {
  it("hides its body until it is open, and follows the caller's expanded state", () => {
    const closed = step({ expandable: true, eyebrow: "Script", title: "Load", children: "BODY" });
    const open = step({
      expandable: true,
      defaultExpanded: true,
      eyebrow: createElement("a", { href: "/source" }, "Source"),
      title: "Load",
      children: "BODY"
    });
    const button = (markup: string) => /<button[^>]*>[\s\S]*?<\/button>/u.exec(markup)?.[0] ?? "";

    expect(button(closed)).toContain('aria-expanded="false"');
    expect(closed).not.toContain("BODY");
    expect(button(open)).toContain('aria-expanded="true"');
    expect(open).toContain("BODY");
    // A link in the eyebrow stays outside the button: a control holds no second control.
    expect(button(open)).not.toContain("<a ");

    const controlled = step({ expandable: true, expanded: true, title: "Load", children: "BODY" });
    expect(controlled).toContain("BODY");
    expect(step({ title: "Load", children: "BODY" })).toContain("BODY");
  });
});
