import { describe, expect, it } from "vitest";
import { item, renderItem } from "./chat-ui-inbox-harness";
import { appsContext, workflowsContext } from "./chat-ui-build-fixtures";
import { inboxPlaces, type ApprovalRevisionHost } from "./support/chat-ui";

// DAILY-WINS 4: an Inbox item leads to what it is about, for a reader who may open it there.

const workspaces = [{ id: "cw_1", kind: "shared" as const, name: "Vertrieb", emoji: null }];

function host(
  context: Parameters<typeof inboxPlaces>[0]["context"],
  open: { apps?: boolean; workflows?: boolean } = {}
): ApprovalRevisionHost {
  return {
    currentUserId: "user-anna",
    personalWorkspaceAgentName: () => undefined,
    startRevision: () => undefined,
    agentDisplayName: () => undefined,
    openConversation: () => undefined,
    places: inboxPlaces({
      context,
      workspaces,
      ownerLabel: "Anna Beispiel",
      appsOpen: open.apps ?? true,
      workflowsOpen: open.workflows ?? true
    })
  };
}

const call = {
  runId: "opr_1",
  operation: "assets.publish",
  effect: "changing",
  actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
  origin: { kind: "user" },
  workspaceId: "cw_1",
  inputs: []
};
const review = {
  name: "offers",
  title: "Offers",
  revision: 2,
  files: [],
  hostsAdded: [],
  connections: [],
  dataStores: []
};
const appPublish = (live: boolean) => ({
  kind: "app_publish",
  summary: "assets.publish",
  canDecide: true,
  preview: { ...call, review: { ...review, kind: "app", ...(live ? { liveRevision: 1 } : {}) } }
});
const workflowPublish = {
  kind: "workflow_publish",
  summary: "assets.publish",
  canDecide: true,
  preview: { ...call, review: { ...review, kind: "workflow", name: "nightly-import" } }
};

/** The place link of the item's foot, as `[href, words]`, or nothing. */
function place(markup: string): [string, string] | undefined {
  const link = /<a[^>]*data-testid="inbox-item-place"[^>]*>([^<]*)<\/a>/u.exec(markup);
  if (!link) return undefined;
  return [/href="([^"]*)"/u.exec(link[0])?.[1] ?? "", link[1] ?? ""];
}

describe("inbox item places", () => {
  it("leads who may write the App to its draft, beside the requester's conversation", () => {
    const writer = host(appsContext({ cw_1: ["app.read", "app.write"] }));
    const markup = renderItem(appPublish(true), { host: writer, locale: "en" });
    expect(place(markup)).toEqual(["/w/cw_1/app-drafts/offers", "Open the draft"]);
    expect(markup).toContain("Open conversation");
    expect(place(renderItem(appPublish(true), { host: writer, locale: "de" }))?.[1]).toBe(
      "Entwurf öffnen"
    );
  });

  it("leads who may only read the App to the live App, and nowhere before the first publish", () => {
    const reader = host(appsContext({ cw_1: ["app.read"] }));
    const live = place(renderItem(appPublish(true), { host: reader, locale: "en" }));
    expect(live?.[1]).toBe("Open the App");
    expect(live?.[0]).toContain("offers");
    expect(live?.[0]).not.toContain("app-drafts");
    expect(place(renderItem(appPublish(false), { host: reader, locale: "en" }))).toBeUndefined();
  });

  it("draws no link the reader cannot open", () => {
    const stranger = host(appsContext({ cw_2: ["app.read", "app.write"] }));
    expect(place(renderItem(appPublish(true), { host: stranger }))).toBeUndefined();
    const closed = host(appsContext({ cw_1: ["app.read", "app.write"] }), { apps: false });
    expect(place(renderItem(appPublish(true), { host: closed }))).toBeUndefined();
    // Without a workspace around it, an item leads nowhere.
    expect(place(renderItem(appPublish(true)))).toBeUndefined();
    // A skill change names no place of its own.
    const writer = host(appsContext({ cw_1: ["app.read", "app.write"] }));
    expect(place(renderItem(item(), { host: writer }))).toBeUndefined();
  });

  it("leads who may read Workflows to the Workflow under review", () => {
    const reader = host(workflowsContext(["workflow.read"]));
    const link = place(renderItem(workflowPublish, { host: reader, locale: "en" }));
    expect(link?.[1]).toBe("Open the Workflow");
    expect(link?.[0]).toContain("nightly-import");
    expect(place(renderItem(workflowPublish, { host: reader, locale: "de" }))?.[1]).toBe(
      "Workflow öffnen"
    );
    expect(
      place(renderItem(workflowPublish, { host: host(workflowsContext([])) }))
    ).toBeUndefined();
    expect(
      place(
        renderItem(workflowPublish, {
          host: host(workflowsContext(["workflow.read"]), { workflows: false })
        })
      )
    ).toBeUndefined();
  });
});
