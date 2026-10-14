import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
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

function card(footer: ReactElement): string {
  return render(
    createElement(
      Card,
      null,
      createElement(CardHeader, null, createElement(CardTitle, null, "Support assistant")),
      createElement(CardFooter, null, footer)
    )
  );
}

const startChat = createElement(Button, { size: "sm" }, "Start chat");

// The card that opens as a whole. Fails without `CardTarget`: a card opened only through the
// button in its footer, so a click on its name or its text did nothing. What a click and the
// keyboard do with it is proven in a browser, in `e2e/ui-library-navigation.spec.ts`.
describe("CardTarget", () => {
  it("marks its child as the card's one target and stretches its area over the card", () => {
    const markup = card(createElement(CardTarget, null, startChat));
    const target = /<button[^>]*>Start chat<\/button>/u.exec(markup)?.[0] ?? "";

    expect(markup.match(/data-card-target=""/gu)).toHaveLength(1);
    expect(target).toContain('data-card-target=""');
    expect(target).toMatch(/class="[^"]*after:absolute after:inset-0/u);
  });

  it("takes the place of the button's own position, so the area is placed against the card", () => {
    const markup = card(createElement(CardTarget, null, startChat));
    const classes = (/<button[^>]*class="([^"]*)"[^>]*>Start chat/u.exec(markup)?.[1] ?? "").split(
      " "
    );

    expect(classes).toContain("static");
    expect(classes).not.toContain("relative");
  });

  it("shows the hover state and the focus of its target on the card's edge while it has a target", () => {
    // The state follows what the card holds, so a card without a target shows none.
    expect(card(startChat)).toMatch(
      /<div data-card="" data-padding="lg" class="[^"]*has-\[\[data-card-target\]\]:hover:border-input-strong[^"]*has-\[\[data-card-target\]\]:hover:bg-state-hover[^"]*has-\[\[data-card-target\]:focus-visible\]:border-input-strong/u
    );
  });
});
