// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { appToolsView } from "@work-shape/catalyst-chat-ui/apps";

describe("the Apps group of an agent's tools for a holder of use", () => {
  // REF-OWNER: a holder of use alone gets each action's name, description and effect, and the
  // chooser offers every one of them under its deterministic tool name.
  it("offers each action of an App the reader may only use under its tool name", () => {
    const view = appToolsView(
      {
        status: "ready",
        apps: [
          {
            name: "billing",
            title: "Billing",
            scope: { kind: "instance" },
            view: "published",
            revision: 2,
            actions: [
              { name: "invoices", effect: "reading", description: "Lists the invoices." },
              { name: "send", effect: "changing" }
            ]
          }
        ]
      },
      ["app.billing.send"]
    );

    expect(view.groups[0]?.tools).toEqual([
      {
        toolName: "app.billing.invoices",
        label: "invoices",
        effect: "reading",
        description: "Lists the invoices."
      },
      { toolName: "app.billing.send", label: "send", effect: "changing" }
    ]);
    expect(view.unavailable).toEqual([]);
  });
});
