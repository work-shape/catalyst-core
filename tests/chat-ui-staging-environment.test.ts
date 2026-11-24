import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { StagingBanner, createEnvironmentDocumentTitle } from "./support/chat-ui";

function renderBanner(environment: string) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "de" },
      createElement(StagingBanner, { environment })
    )
  );
}

describe("the staging environment", () => {
  it("shows the banner and prefixes the title in staging only", () => {
    expect(renderBanner("staging")).toContain('role="status"');
    expect(renderBanner("production")).not.toContain('role="status"');
    expect(createEnvironmentDocumentTitle("Musterfinanz", "staging")).toBe("(Test) Musterfinanz");
    expect(createEnvironmentDocumentTitle("Musterfinanz", "production")).toBe("Musterfinanz");
    expect(createEnvironmentDocumentTitle("Musterfinanz", undefined)).toBe("Musterfinanz");
  });
});
