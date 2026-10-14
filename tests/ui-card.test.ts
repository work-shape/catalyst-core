import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardReachable,
  CardTarget,
  CardTitle,
  UiRoot,
  uiLabelsEn
} from "@vivd-catalyst/ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

function card(footer: ReactElement, extra?: ReactElement): string {
  return render(
    createElement(
      Card,
      null,
      createElement(
        CardHeader,
        null,
        createElement(CardTitle, { id: "title-1" }, "Support assistant"),
        extra
      ),
      createElement(CardFooter, null, footer)
    )
  );
}

const startChat = createElement(Button, { size: "sm" }, "Start chat");
const target = createElement(CardTarget, { titleId: "title-1", children: startChat });

/** The opening tag of the button whose text is `label`. */
function buttonTag(markup: string, label: string): string {
  return new RegExp(`<button[^>]*>${label}</button>`, "u").exec(markup)?.[0] ?? "";
}

// The card that opens as a whole. Fails without `CardTarget`: a card opened only through the
// button in its footer, so a click on its name or its text did nothing. What a click, a drag
// and the keyboard do with it is proven in a browser, in `e2e/ui-library-navigation.spec.ts`.
describe("CardTarget", () => {
  it("marks its child as the card's one target and stretches its area over the card", () => {
    const markup = card(target);
    const tag = buttonTag(markup, "Start chat");

    expect(markup.match(/data-card-target=""/gu)).toHaveLength(1);
    expect(tag).toContain('data-card-target=""');
    expect(tag).toMatch(/class="[^"]*after:absolute after:inset-0/u);
    // A pointer over the card shows that it opens, whether the target is a link or a button.
    expect(tag).toMatch(/class="[^"]*cursor-pointer/u);
  });

  it("takes the place of the button's own position, so the area is placed against the card", () => {
    const classes = (
      /class="([^"]*)"/u.exec(buttonTag(card(target), "Start chat"))?.[1] ?? ""
    ).split(" ");

    expect(classes).toContain("static");
    expect(classes).not.toContain("relative");
  });

  it("is named by its own text and the card's title", () => {
    const tag = buttonTag(card(target), "Start chat");
    const ownId = /\sid="([^"]+)"/u.exec(tag)?.[1] ?? "";

    expect(ownId).not.toBe("");
    expect(tag).toContain(`aria-labelledby="${ownId} title-1"`);
  });

  it("shows the hover state only while the pointer is on the target's area, and its focus", () => {
    // A control above the area, such as a menu, leaves the card at rest.
    expect(card(target)).toMatch(
      /<div data-card="" data-padding="lg" class="[^"]*has-\[\[data-card-target\]:hover\]:border-input-strong[^"]*has-\[\[data-card-target\]:hover\]:bg-state-hover[^"]*has-\[\[data-card-target\]:focus-visible\]:border-input-strong/u
    );
  });

  it("marks content that stays reachable above the target, and leaves it as it is", () => {
    const time = createElement(
      "time",
      { dateTime: "2026-10-13", title: "13 October 2026" },
      "Yesterday"
    );
    const markup = card(target, createElement(CardReachable, null, time));

    expect(markup).toContain(
      '<time dateTime="2026-10-13" title="13 October 2026" data-card-reachable="">Yesterday</time>'
    );
  });
});
