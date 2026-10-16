import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "./chat-ui-render-harness";
import { MarkdownArtifact, MarkdownLinkPolicyProvider } from "./support/chat-ui";

const policy = {
  ownOrigins: ["https://chat.example.com"],
  allowedLinkHosts: ["docs.example.org", "*.partner.example"]
};

describe("chat UI Markdown rendering", () => {
  it("renders fenced code with theme-aware Streamdown controls", () => {
    const markup = renderMarkdown("```typescript\nconst answer = 42;\n```");

    expect(markup).toContain('data-streamdown="code-block"');
    expect(markup).toContain('data-streamdown="code-block-copy-button"');
    expect(markup).toContain('title="Copy code"');
    expect(markup).toContain("--shiki-dark");
  });

  it("delegates Mermaid blocks to the lazy diagram renderer", () => {
    const markup = renderMarkdown("```mermaid\nflowchart TD\n  A --> B\n```");

    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain('data-streamdown="code-block"');
    expect(markup).not.toContain("flowchart TD");
  });
});

describe("Markdown remote content", () => {
  it("loads no remote image and shows its description instead", () => {
    const markup = renderMarkdown("![Chart](https://cdn.example.net/chart.png)");

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("cdn.example.net");
    expect(markup).toContain("Image not loaded: Chart");
    expect(markup).toContain("chat-markdown-blocked-image");
    expect(markup).not.toContain("[Image blocked");
  });

  it("loads no data: image", () => {
    const markup = renderMarkdown("![Dot](data:image/png;base64,iVBORw0KGgo=)");

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("data:image");
  });

  it("loads no tracking pixel written as HTML in a file preview", () => {
    const markup = renderMarkdown(
      [
        "Quarterly report",
        "",
        '<img src="https://track.example.net/p.gif?u=42" width="1" height="1" alt="">',
        "",
        '<picture><source srcset="https://track.example.net/s.gif"><img src="https://track.example.net/i.gif"></picture>'
      ].join("\n")
    );

    expect(markup).toContain("Quarterly report");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("track.example.net");
    expect(markup).not.toMatch(/srcset/iu);
  });

  it("keeps links to the instance and to allowed hosts", () => {
    const markup = renderMarkdown(
      [
        "[Guide](https://docs.example.org/guide)",
        "[Partner](https://portal.partner.example/a)",
        "[Settings](/settings)",
        "[Own](https://chat.example.com/c/1)"
      ].join("\n\n")
    );

    // Streamdown shows a kept link as a button that confirms before it opens the address.
    expect(markup.match(/data-streamdown="link"/gu)).toHaveLength(4);
    expect(markup).not.toContain("chat-markdown-blocked-link");
  });

  it("shows a link to any other host as text with its address", () => {
    const markup = renderMarkdown("Read [the offer](https://evil.example.net/offer?id=7) now.");

    expect(markup).not.toContain('data-streamdown="link"');
    expect(markup).toContain("chat-markdown-blocked-link");
    expect(markup).toContain("the offer (https://evil.example.net/offer?id=7)");
  });

  it("names a blocked image in the reader's language", () => {
    const markup = renderMarkdown(
      "![Diagramm](https://cdn.example.net/d.png)\n\n![](https://cdn.example.net/e.png)",
      "de"
    );

    expect(markup).toContain("Bild nicht geladen: Diagramm");
    expect(markup).toContain("Bild nicht geladen<");
    expect(markup).not.toContain("cdn.example.net");
  });

  it("shows a link with a refused protocol as its text, without the library's marker", () => {
    // The sanitizer drops a `javascript:` address before the link rule sees it.
    const markup = renderMarkdown("[run](javascript:alert(1))");

    expect(markup).not.toContain('data-streamdown="link"');
    expect(markup).not.toContain("[blocked]");
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain('<span class="chat-markdown-blocked-link">run</span>');
  });

  it("shows a bare address once when the link text is the address", () => {
    const markup = renderMarkdown("See https://evil.example.net/x");

    expect(markup).not.toContain('data-streamdown="link"');
    expect(markup.match(/evil\.example\.net\/x/gu)).toHaveLength(2);
  });

  it("allows links only to the instance, listed hosts and mail", () => {
    const staysLink = (href: string) =>
      renderMarkdown(`[x](${href})`).includes('data-streamdown="link"');

    expect(staysLink("#section")).toBe(true);
    expect(staysLink("mailto:team@example.com")).toBe(true);
    expect(staysLink("/files/a.pdf")).toBe(true);
    expect(staysLink("https://DOCS.example.org/x")).toBe(true);
    expect(staysLink("https://a.b.partner.example/x")).toBe(true);
    expect(staysLink("https://partner.example/x")).toBe(false);
    expect(staysLink("https://docs.example.org.evil.net/x")).toBe(false);
    expect(staysLink("//evil.example.net/x")).toBe(false);
    expect(staysLink("ftp://docs.example.org/x")).toBe(false);
    expect(staysLink("javascript:alert(1)")).toBe(false);
  });
});

function renderMarkdown(markdown: string, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(
        MarkdownLinkPolicyProvider,
        { ...policy, children: null },
        createElement(MarkdownArtifact, null, markdown)
      )
    )
  );
}
