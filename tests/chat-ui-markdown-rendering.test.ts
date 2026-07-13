import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { MarkdownArtifact } from "../packages/chat-ui/src/markdown-text";

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

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" },
      createElement(MarkdownArtifact, null, markdown)
    )
  );
}
