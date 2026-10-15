import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextLink, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

// A link inside a line of text. Fails without `TextLink`: the library had a link only as a
// button, which brings a control's height and padding into the line.
describe("TextLink", () => {
  it("is an anchor with the address and the handlers it is given", () => {
    const markup = render(createElement(TextLink, { href: "/w/1/workflows/a" }, "Monthly check"));

    expect(markup).toMatch(/<a[^>]*href="\/w\/1\/workflows\/a"[^>]*>Monthly check<\/a>/u);
  });

  it("takes the size of the text around it and no height or padding of a control", () => {
    const markup = render(createElement(TextLink, { href: "#" }, "More"));

    expect(markup).not.toMatch(/class="[^"]*\b(?:text-(?:label|body|caption)|h-control|px-)/u);
    expect(markup).toMatch(/class="[^"]*hover:underline[^"]*focus-visible:focus-ring/u);
  });

  it("keeps a class of its caller beside its own", () => {
    expect(render(createElement(TextLink, { href: "#", className: "truncate" }, "More"))).toMatch(
      /class="[^"]*hover:underline[^"]*truncate/u
    );
  });
});
