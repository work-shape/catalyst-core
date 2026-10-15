import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ShippedGuardrailView } from "@vivd-catalyst/api-client";
import { ShippedGuardrails, type ShippedGuardrailsRead } from "@vivd-catalyst/chat-ui/build-area";
import { render, renderItem } from "./chat-ui-inbox-harness";

// GR-PUB-1 in the interface: the switch of the guardrail the release ships on Build >
// Guardrails, and the Inbox item of a publish that waits for an approver.

const shipped: ShippedGuardrailView = {
  name: "publishing-needs-approval",
  displayName: "Publishing needs an instance admin's approval",
  reason: "A new revision of an App or a Workflow goes live once an instance admin approved it.",
  on: ["app.before_publish", "workflow.before_publish"],
  outcome: "require_approval",
  enabled: true,
  canSwitch: true
};

function renderShipped(items: ShippedGuardrailView[], locale: "de" | "en" = "en") {
  const read: ShippedGuardrailsRead = {
    status: "ready",
    items,
    switching: undefined,
    switchTo: () => Promise.resolve(undefined)
  };
  return render(createElement(ShippedGuardrails, { read }), locale);
}

describe("the guardrail the release ships, on Build > Guardrails", () => {
  it("shows it on, in the reader's language, with a switch an instance admin can use", () => {
    const english = renderShipped([shipped]);
    expect(english).toContain("Publishing needs an instance admin&#x27;s approval");
    expect(english).toContain("On, as the platform ships it.");
    expect(english).toMatch(/role="switch"[^>]*aria-checked="true"/u);
    expect(english).not.toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);

    const german = renderShipped([shipped], "de");
    expect(german).toContain("Veröffentlichen braucht die Freigabe eines Instanz-Admins");
    expect(german).toContain("Eingeschaltet, wie die Plattform sie liefert.");
  });

  it("says who switched it off and holds the switch for a reader who may not switch it", () => {
    const markup = renderShipped([
      {
        ...shipped,
        enabled: false,
        canSwitch: false,
        switchedBy: { id: "usr_admin", label: "Ada Admin" },
        switchedAt: "2026-10-14T21:00:00.000Z"
      }
    ]);
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="false"/u);
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]* disabled=""/u);
    expect(markup).toContain("Switched off by Ada Admin");
    expect(markup).toContain("Only an instance admin can switch it.");
    expect(markup).toContain("makes a new version live with their own click");
  });
});

describe("the Inbox item of a publish that waits", () => {
  const preview = {
    runId: "opr_1",
    operation: "assets.publish",
    effect: "changing",
    actor: { kind: "user", id: "usr_kai", label: "Kai Member" },
    origin: { kind: "user" },
    inputs: [{ key: "revision", value: "2" }],
    review: {
      kind: "app",
      name: "offers",
      title: "Offers",
      revision: 2,
      liveRevision: 1,
      files: [{ path: "index.html", change: "changed" }],
      changing: [{ label: "send_offer", change: "new" }],
      hostsAdded: ["api.example.com"],
      connections: ["crm"],
      dataStores: [{ name: "findings", minSchema: 3 }]
    }
  };
  const publish = (review: Record<string, unknown> = {}, locale: "de" | "en" = "en") =>
    renderItem(
      {
        kind: "app_publish",
        summary: "assets.publish",
        preview: { ...preview, review: { ...preview.review, ...review } },
        canDecide: true
      },
      { locale }
    );

  it("says who wants to publish what, and shows the review against the live version", () => {
    const markup = publish();
    expect(markup).toContain('data-testid="publish-review"');
    expect(markup).toContain("Kai Member wants to publish a new version of the App “Offers”.");
    expect(markup).toContain("Version 2, in place of version 1");
    expect(markup).toMatch(/data-field="files".*index\.html.*Changed/u);
    expect(markup).toMatch(/data-field="changing".*send_offer.*New/u);
    expect(markup).toMatch(/data-field="hosts".*api\.example\.com/u);
    expect(markup).toMatch(/data-field="connections".*crm/u);
    expect(markup).toMatch(/data-field="data-stores".*findings \(level 3\)/u);
    expect(markup).toContain("Approve and publish");
    // The call's inputs stay in the fold; the review stands for them.
    expect(markup).not.toContain('data-testid="operation-call-inputs"');

    const german = publish({}, "de");
    expect(german).toContain(
      "Kai Member möchte eine neue Version der App „Offers“ veröffentlichen."
    );
    expect(german).toContain("Freigeben und veröffentlichen");
  });

  it("says a request whose draft moved can no longer be approved", () => {
    expect(publish({ stale: "draft_moved" })).toMatch(
      /data-testid="publish-review-stale".*The draft changed since the request was made/u
    );
  });
});
