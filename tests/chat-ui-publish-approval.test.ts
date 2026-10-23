import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { appPublishDataKey } from "@work-shape/catalyst-chat-ui/apps";
import { INBOX_API_BASE_URL, renderItem } from "./chat-ui-inbox-harness";

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

  it("shows a workspace agent's draft against live, what it adds and where it is offered (WS-PUB-1b)", () => {
    const review = {
      kind: "agent",
      name: "kai-helper",
      title: "Kai Helper",
      revision: 3,
      liveRevision: 1,
      files: [],
      hostsAdded: [],
      connections: [],
      dataStores: [],
      agent: {
        workspace: { id: "cws_kai", name: "Kai Spezis" },
        offers: true,
        fields: [
          { field: "instructions", change: "changed" },
          { field: "toolNames", change: "added" }
        ],
        toolsAdded: ["known.tool"],
        toolsRemoved: [],
        modelBindingsAdded: ["plain"],
        skills: ["team-notes"],
        instructions: { after: "Answer in German.", before: "Help." }
      }
    };
    const agentItem = (locale: "de" | "en") =>
      renderItem(
        {
          kind: "agent_publish",
          summary: "assets.publish",
          preview: { ...preview, review },
          canDecide: true
        },
        { locale }
      );
    const markup = agentItem("en");
    expect(markup).toContain("Draft based on version 1");
    expect(markup).toMatch(/data-testid="publish-review-workspace"[^>]*>Kai Spezis/u);
    expect(markup).toContain("Approving also offers the agent to everyone in Kai Spezis.");
    expect(markup).toMatch(/data-agent-field="instructions".*Instructions.*Changed/u);
    expect(markup).toMatch(/data-field="tools-added".*known\.tool/u);
    expect(markup).toMatch(/data-field="models-added".*plain/u);
    expect(markup).toMatch(/data-field="skills".*team-notes/u);
    expect(markup).toContain("Answer in German.");
    expect(markup).toContain("Approve and publish");
    // An agent has no files, hosts or stores of its own, so the App's lists stay away.
    expect(markup).not.toContain('data-field="files"');

    const german = agentItem("de");
    expect(german).toContain("Entwurf auf Basis von Version 1");
    expect(german).toContain("Freigeben bietet den Agenten außerdem allen in Kai Spezis an.");
  });

  it("reviews a first version alone, with no live version beside it (access check 11)", () => {
    const review = {
      kind: "agent",
      name: "lena-made",
      title: "Lena Made",
      revision: 1,
      files: [],
      hostsAdded: [],
      connections: [],
      dataStores: [],
      agent: {
        workspace: { id: "cws_kai", name: "Kai Spezis" },
        offers: true,
        toolsAdded: ["known.tool"],
        toolsRemoved: [],
        modelBindingsAdded: [],
        skills: [],
        instructions: { after: "Help." }
      }
    };
    const firstItem = (locale: "de" | "en") =>
      renderItem(
        {
          kind: "agent_publish",
          summary: "assets.publish",
          preview: { ...preview, review },
          canDecide: true
        },
        { locale }
      );
    const markup = firstItem("en");
    expect(markup).toMatch(/data-field="version".*First version/u);
    expect(markup).toMatch(/data-field="instructions"><dt[^>]*>Instructions</u);
    expect(markup).not.toContain('data-field="agent-fields"');
    expect(markup).not.toContain('data-field="instructions-live"');
    expect(markup).toContain("Approving also offers the agent to everyone in Kai Spezis.");
    expect(firstItem("de")).toContain("Erste Version");
  });

  it("says the instructions are withheld from an approver who may not read the agent", () => {
    const review = {
      kind: "agent",
      name: "secret-helper",
      title: "Secret Helper",
      revision: 1,
      liveRevision: 1,
      files: [],
      hostsAdded: [],
      connections: [],
      dataStores: [],
      agent: {
        workspace: { id: "cws_kai", name: "Kai Spezis" },
        offers: false,
        fields: [{ field: "instructions", change: "changed" }],
        toolsAdded: [],
        toolsRemoved: [],
        modelBindingsAdded: [],
        skills: [],
        instructionsWithheld: true
      }
    };
    const withheld = (locale: "de" | "en") =>
      renderItem(
        {
          kind: "agent_publish",
          summary: "assets.publish",
          preview: { ...preview, review },
          canDecide: true
        },
        { locale }
      );
    const markup = withheld("en");
    expect(markup).toContain('data-field="instructions-withheld"');
    expect(markup).toContain("You may not read this agent, so its instructions are not shown.");
    expect(markup).not.toContain('data-testid="publish-review-instructions"');
    expect(withheld("de")).toContain(
      "Du darfst diesen Agenten nicht lesen. Deshalb werden seine Anweisungen nicht gezeigt."
    );
  });

  it("says a request whose draft moved can no longer be approved", () => {
    expect(publish({ stale: "draft_moved" })).toMatch(
      /data-testid="publish-review-stale".*The draft changed since the request was made/u
    );
  });

  it("names who would see which stored data for the version it publishes, not the live one: check 67", () => {
    const answered = new QueryClient();
    const store = (actions: string[]) => ({
      name: "findings",
      title: "Findings",
      fillers: [
        { kind: "workflow", name: "nightly", title: "Nachtimport", connections: ["Exampledata"] }
      ],
      actions,
      rows: { estimate: 312, tables: 2, measuredAt: "2026-10-18T03:00:00Z" }
    });
    answered.setQueryData(appPublishDataKey(INBOX_API_BASE_URL, "offers", 2), {
      stores: [store(["list_findings"])],
      revision: 2,
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 0 },
      truncated: false
    });
    // What the live version 1 shows is cached too, and is not what this request makes live.
    answered.setQueryData(appPublishDataKey(INBOX_API_BASE_URL, "offers", 1), {
      stores: [store(["live_only_action"])],
      revision: 1,
      audience: { workspace: { title: "Live Team", members: 3 }, holders: [], hiddenHolders: 0 },
      truncated: false
    });
    const markup = renderItem(
      {
        kind: "app_publish",
        summary: "assets.publish",
        preview,
        canDecide: true
      },
      { locale: "en", queryClient: answered }
    );
    expect(markup).toMatch(/data-field="data-audience".*Everyone in Kai Spezis \(14 people\)/u);
    expect(markup).toMatch(/data-data-store="findings".*The action list_findings reads from it\./u);
    expect(markup).toContain("about 312 rows in 2 tables when last measured");
    expect(markup).toContain("which the Workflow “Nachtimport” copies from Exampledata.");
    expect(markup).not.toContain("live_only_action");
    expect(markup).not.toContain("Live Team");

    // A Workflow's publish and an App that reads no store have no such lines; neither has a
    // request whose App is gone.
    expect(publish({ kind: "workflow" })).not.toContain("data-audience");
    expect(publish({ dataStores: [] })).not.toContain("data-audience");
    expect(publish({ stale: "gone" })).not.toContain("data-audience");
    // Until the answer is there the lines are being read.
    expect(publish()).toContain('data-field="data-audience"');
  });

  it("holds Approve until the lines on stored data are there, as Publish waits in the dialog", () => {
    const button = (markup: string, decision: string) =>
      markup.match(new RegExp(`<button[^>]*data-decision="${decision}"[^>]*>`, "u"))?.[0] ?? "";
    const held = (markup: string) => button(markup, "approve").includes(' disabled=""');
    const answer = {
      stores: [{ name: "findings", title: "Findings", fillers: [], actions: ["list_findings"] }],
      revision: 2,
      audience: { workspace: { title: "Kai Spezis", members: 14 }, holders: [], hiddenHolders: 0 },
      truncated: false
    };
    const item = { kind: "app_publish", summary: "assets.publish", preview, canDecide: true };
    const answered = (data: unknown) => {
      const client = new QueryClient();
      client.setQueryData(appPublishDataKey(INBOX_API_BASE_URL, "offers", 2), data);
      return renderItem(item, { locale: "en", queryClient: client });
    };

    // While they load: Approve is held, Decline is not.
    const loading = publish();
    expect(button(loading, "approve")).not.toBe("");
    expect(held(loading)).toBe(true);
    expect(button(loading, "reject")).not.toContain(' disabled=""');
    // After their read failed: an answer that does not describe this version is one.
    const failed = answered({ ...answer, revision: 1 });
    expect(failed).toContain('data-testid="app-publish-data-failed"');
    expect(held(failed)).toBe(true);
    expect(held(answered({ ...answer, audience: undefined }))).toBe(true);
    // Once they are there.
    expect(held(answered(answer))).toBe(false);
    // A publish that shows no such lines waits for nothing.
    expect(held(publish({ kind: "workflow" }))).toBe(false);
    expect(held(publish({ dataStores: [] }))).toBe(false);
  });
});
