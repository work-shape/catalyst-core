import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyText, UiRoot, uiLabelsDe, type CopyTextProps } from "@work-shape/catalyst-ui";

// CopyText shows a text somebody takes elsewhere, as text and not as code, beside one button
// that copies it.

const render = (props: CopyTextProps) =>
  renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsDe }, createElement(CopyText, props))
  );

const bodyOf = (markup: string) =>
  /data-slot="copy-text-body" class="([^"]*)">([^<]*)</u.exec(markup);

describe("CopyText", () => {
  const text = "Guten Tag Frau Okafor,\n\n  vielen Dank für das Angebot.\n";

  it("shows the text in the font around it, wrapped, with every line break kept", () => {
    const body = bodyOf(render({ text }));

    expect(body?.[2]).toBe(text);
    expect(body?.[1]).toContain("whitespace-pre-wrap");
    expect(body?.[1]).toContain("wrap-anywhere");
    expect(body?.[1]).not.toContain("font-mono");
  });

  it("shows the text as text, never as markup", () => {
    const markup = render({ text: "<b>fett</b> & **mehr**" });

    expect(markup).toContain("&lt;b&gt;fett&lt;/b&gt; &amp; **mehr**");
    expect(markup).not.toContain("<b>");
  });

  it("names the text with its label, shown on one line", () => {
    const markup = render({ text, label: "Antwort an den Lieferanten" });

    expect(markup).toMatch(/role="group" aria-label="Antwort an den Lieferanten"/u);
    expect(markup).toMatch(
      /data-slot="copy-text-label" class="[^"]*truncate[^"]*">Antwort an den Lieferanten</u
    );
  });

  it("has no label unless one is given", () => {
    const markup = render({ text });

    expect(markup).not.toContain("copy-text-label");
    expect(markup).not.toContain('aria-label=""');
  });

  it("offers one button that copies, and none while the text is still being written", () => {
    expect(render({ text }).match(/<button/gu)).toHaveLength(1);
    expect(render({ text })).toContain(`aria-label="${uiLabelsDe.copy}"`);
    expect(render({ text, pending: true })).not.toContain("<button");
  });

  it("needs a UiRoot for its button's label", () => {
    expect(() => renderToStaticMarkup(createElement(CopyText, { text }))).toThrow(/CopyText/u);
  });
});
