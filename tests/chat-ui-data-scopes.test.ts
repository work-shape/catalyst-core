import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { DataScopes } from "@work-shape/catalyst-chat-ui/access";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

function render(locale: "en" | "de", values: string[] = [], inherited = values) {
  const client = createApiClient({ baseUrl: "http://localhost" });
  const query = new QueryClient();
  query.setQueryData(["data-scopes", "reader", "user", "reader"], {
    dimensions: { mandant: { label: "Mandant", valueType: "text" } },
    assignments: [
      { dimension: "mandant", holderKind: "user", holderId: "reader", effect: "allow", values }
    ],
    effective: { mandant: inherited }
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: query,
      children: createElement(TranslationProvider, {
        locale,
        children: createElement(DataScopes, {
          client,
          userId: "reader",
          users: [{ id: "reader", displayLabel: "Reader" }]
        })
      })
    })
  );
}

describe("data scope assignment controls", () => {
  it("explains no assignment in German and English", () => {
    expect(render("de")).toContain("Ihnen ist kein Mandant zugeordnet");
    expect(render("en")).toContain("No Mandant is assigned to you.");
  });
  it("shows editable existing values and does not claim inherited values are missing", () => {
    expect(render("en", ["101", "102"])).toContain('value="101, 102"');
    expect(render("de", [], ["101"])).not.toContain("Ihnen ist kein Mandant zugeordnet");
  });
});
