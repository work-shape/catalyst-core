import { createElement } from "react";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "./chat-ui-render-harness";
import { StagingBanner } from "../packages/chat-ui/src/workspace/workspace-chrome";
import { createEnvironmentDocumentTitle } from "../packages/chat-ui/src/workspace-utils";

function renderBanner(environment: string, locale: "de" | "en" = "de") {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(StagingBanner, { environment })
    )
  );
}

describe("staging environment banner", () => {
  it("shows only the localized test-environment label in staging", () => {
    const markup = renderBanner("staging");

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Testumgebung");
    expect(markup).not.toContain("Echtdaten");
  });

  it.each(["development", "production"])("stays hidden in %s", (environment) => {
    const markup = renderBanner(environment);

    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("Testumgebung");
  });
});

describe("environment document title", () => {
  it("prefixes staging titles with the user-facing test label", () => {
    expect(createEnvironmentDocumentTitle("Musterfinanz", "staging")).toBe(
      "(Test) Musterfinanz"
    );
  });

  it.each(["development", "production", undefined])(
    "leaves titles unchanged in %s",
    (environment) => {
      expect(createEnvironmentDocumentTitle("Musterfinanz", environment)).toBe(
        "Musterfinanz"
      );
    }
  );
});
