import { describe, expect, it } from "vitest";
import { renderItem } from "./chat-ui-inbox-harness";

// GR-PUB-1 in the interface: the Inbox item of a publish that waits for an approver. The switch
// of the guardrail the release ships is in `chat-ui-guardrails-list.test.ts`.

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
