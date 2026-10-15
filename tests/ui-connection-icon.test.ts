import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectionIcon, IconRegistryProvider } from "@work-shape/catalyst-ui";

describe("ConnectionIcon", () => {
  const Mark = () => createElement("svg", { "data-mark": "ledger" });
  const render = (props: Parameters<typeof ConnectionIcon>[0]) =>
    renderToStaticMarkup(
      createElement(IconRegistryProvider, {
        icons: { ledger: Mark },
        children: createElement(ConnectionIcon, props)
      })
    );

  it("shows the icon an application registered for the service", () => {
    const markup = render({ service: "ledger", category: "database" });
    expect(markup).toContain('data-mark="ledger"');
    expect(markup).toContain('data-connection-icon="ledger"');
  });

  it("falls back to the kind of system, then to the generic Connection icon", () => {
    expect(render({ service: "not-registered", category: "database" })).toContain(
      "lucide-database"
    );
    expect(render({ category: "database" })).toContain('data-connection-icon="database"');
    expect(render({})).toContain('data-connection-icon="generic"');
    expect(render({})).toBe(
      render({ service: "not-registered" }).replace("not-registered", "generic")
    );
  });

  it("sits on a rounded tile at every size and is hidden from assistive technology", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const markup = render({ size });
      expect(markup).toMatch(/^<span aria-hidden="true"/u);
      expect(markup).toMatch(/\bbg-secondary\b/u);
      expect(markup).toMatch(/\brounded-(sm|md)\b/u);
    }
  });
});
