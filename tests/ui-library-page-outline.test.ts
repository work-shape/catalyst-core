import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Page,
  PageBar,
  PageHeader,
  PageOutline,
  Section,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

function render(element: ReactElement, labels = uiLabelsEn): string {
  return renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, element));
}

describe("the outline of a page's sections", () => {
  const items = [
    { id: "overview", label: "Overview" },
    { id: "tools", label: "Tools", count: 16 },
    { id: "model", label: "Model", invalid: true }
  ];
  const outline = (belowHeader = false) => createElement(PageOutline, { items, belowHeader });
  const linkTo = (markup: string, id: string) =>
    markup.match(new RegExp(`<a href="#${id}"[^>]*>.*?</a>`, "u"))?.[0] ?? "";

  it("is a navigation landmark named in the reader's language", () => {
    expect(render(outline())).toMatch(/^<div[^>]*><nav aria-label="On this page"/u);
    const german = render(outline(), uiLabelsDe);
    expect(german).toMatch(/<nav aria-label="Auf dieser Seite"/u);
    // The line it shows is hidden from assistive technology: the landmark carries the name.
    expect(german).toMatch(/<p aria-hidden="true"[^>]*>Auf dieser Seite<\/p>/u);
  });

  it("links to every section and marks the first as the one in view, without a pill", () => {
    const markup = render(outline());
    for (const item of items) {
      expect(linkTo(markup, item.id)).toContain(`>${item.label}</span>`);
    }
    expect(linkTo(markup, "overview")).toContain('aria-current="location"');
    expect(linkTo(markup, "overview")).toMatch(/class="[^"]*border-foreground/u);
    expect(linkTo(markup, "overview")).toContain("border-l-2");
    expect(markup.match(/aria-current=/gu)).toHaveLength(1);
    expect(linkTo(markup, "tools")).toMatch(/class="[^"]*border-transparent/u);
    // What makes a `NavItem` look selected is nowhere in it.
    expect(markup).not.toContain("bg-state-selected");
  });

  it("shows a count muted after the name, not as a badge", () => {
    const tools = linkTo(render(outline()), "tools");
    expect(tools).toMatch(
      />Tools<\/span><span class="[^"]*text-muted-foreground[^"]*">16<\/span>/u
    );
    expect(tools).not.toContain("rounded-full");
    expect(linkTo(render(outline()), "overview")).not.toContain("tabular-nums");
  });

  it("marks a section with an error, in words too", () => {
    const markup = render(outline());
    const model = linkTo(markup, "model");
    expect(model).toContain('data-invalid=""');
    expect(model).toMatch(/<svg[^>]*text-destructive[^>]*aria-hidden="true"/u);
    expect(model).toContain('<span class="sr-only">Has an error</span>');
    expect(linkTo(markup, "tools")).not.toContain("data-invalid");
    expect(linkTo(render(outline(), uiLabelsDe), "model")).toContain("Enthält einen Fehler");
  });

  it("is one line with a choice of the sections where the page lacks the room", () => {
    const markup = render(outline());
    expect(markup).toMatch(/<label class="[^"]*@outline\/page:hidden[^"]*">/u);
    expect(markup).toMatch(/<span[^>]*>On this page:<\/span>/u);
    expect(markup).toContain('<option value="overview" selected="">Overview</option>');
    expect(markup).toContain('<option value="tools">Tools (16)</option>');
    expect(markup).toContain('<option value="model">Model – Has an error</option>');
    // The list of links shows only beside the content.
    expect(markup).toMatch(/<div class="hidden @outline\/page:block">/u);
  });

  it("is pinned only beside the content, under the page's head where there is one", () => {
    const classes = (markup: string) =>
      markup.match(/data-page-outline="" class="([^"]*)"/u)?.[1]?.split(" ") ?? [];
    expect(classes(render(outline()))).toContain("@outline/page:sticky");
    expect(classes(render(outline()))).not.toContain("sticky");
    // Under a head it rests below the head as tall as it is measured, not as tall as the token:
    // on a phone the head has two lines. The token stands in until the head is measured.
    const underHead = "top-(--page-outline-head,var(--layout-header))";
    expect(classes(render(outline(true)))).toContain(underHead);
    expect(classes(render(outline()))).not.toContain(underHead);
    const head = render(createElement(PageHeader, { variant: "detail", title: "HEAD" }));
    expect(head).toMatch(/<header[^>]*data-page-head=""/u);
    expect(render(createElement(PageHeader, { title: "HEAD" }))).not.toContain("data-page-head");
  });

  it("pins a bar of the content directly below the head, under the head's layer", () => {
    const classes =
      render(createElement(PageBar, null, "BAR"))
        .match(/<div data-page-bar="" class="([^"]*)">BAR</u)?.[1]
        ?.split(" ") ?? [];
    expect(classes).toEqual(
      expect.arrayContaining([
        "sticky",
        // As tall as the head is measured; the token stands in until then.
        "top-(--page-bar-top,var(--layout-header))",
        "z-[calc(var(--layer-sticky-header)-1)]",
        // What scrolls under it does not show through.
        "bg-background"
      ])
    );
  });

  it("draws the focus line of a link inside it, where the scrolling outline does not clip it", () => {
    const link = linkTo(render(outline()), "tools");
    expect(link).toMatch(/class="[^"]*focus-visible:-outline-offset-2/u);
    expect(link).not.toContain("focus-visible:focus-ring");
  });

  it("marks the closed line when some section has an error", () => {
    const line = (markup: string) => markup.match(/<label.*?<\/label>/u)?.[0] ?? "";
    const marked = line(render(outline()));
    // After the choice, so it shows whichever section the line names.
    expect(marked).toMatch(
      /<\/select>.*<span data-invalid=""[^>]*><svg[^>]*text-destructive[^>]*>.*<\/svg><span class="sr-only">Has an error<\/span><\/span><\/label>$/u
    );
    const clean = createElement(PageOutline, { items: [{ id: "a", label: "A" }] });
    expect(line(render(clean))).not.toContain("data-invalid");
  });

  it("keeps the content where it is on a page whose outline is left out", () => {
    const page = (slot: ReactElement | null) =>
      render(
        createElement(
          Page,
          {
            width: "narrow",
            header: createElement(PageHeader, { variant: "detail", title: "HEAD" }),
            outline: slot
          },
          "BODY"
        )
      );
    const content = (markup: string) => markup.match(/<div class="([^"]*)">BODY</u)?.[1];
    expect(content(page(null))).toBe(content(page(outline(true))));
    expect(page(null)).toContain("@outline/page:grid-cols-[minmax(0,1fr)_var(--layout-outline)]");
    expect(page(null)).not.toContain("data-page-outline");
  });

  it("gives a title above its fields a larger size than the fields' labels", () => {
    const heading = (layout: "stacked" | "split") =>
      render(createElement(Section, { layout, title: "TITLE" }, "FIELDS")).match(
        /<h2 class="([^"]*)">TITLE/u
      )?.[1];
    expect(heading("stacked")).toBe("min-w-0 text-title-sm");
    expect(heading("split")).toBe("min-w-0 text-heading");
  });

  it("stands at the page's right edge, and the content is centred in the room left of it", () => {
    const markup = render(
      createElement(
        Page,
        {
          width: "narrow",
          header: createElement(PageHeader, { variant: "detail", title: "HEAD" }),
          outline: outline(true)
        },
        "BODY"
      )
    );
    // In the document the outline comes first, so the keyboard reaches it before the content.
    expect(markup.indexOf("HEAD")).toBeLessThan(markup.indexOf("data-page-outline"));
    expect(markup.indexOf("data-page-outline")).toBeLessThan(markup.indexOf("BODY"));
    expect(markup).toMatch(
      /<div class="[^"]*@outline\/page:grid-cols-\[minmax\(0,1fr\)_var\(--layout-outline\)\][^"]*">/u
    );
    expect(markup).toMatch(/<div class="[^"]*@outline\/page:col-start-2[^"]*"><nav/u);
    const content = markup.match(/<div class="([^"]*)">BODY</u)?.[1]?.split(" ") ?? [];
    expect(content).toEqual(
      expect.arrayContaining([
        "@outline/page:col-start-1",
        "max-w-(--layout-content-narrow)",
        "mx-auto"
      ])
    );
    // The row takes the page's whole width, so the outline's column ends on the page's edge.
    expect(markup).not.toMatch(/@outline\/page:grid-cols-[^"]*max-w-/u);
  });
});
