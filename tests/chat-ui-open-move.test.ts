import { describe, expect, it } from "vitest";
import {
  lastRunParts,
  pendingOpen,
  placeFollowsOpens,
  planOpenMoves
} from "@work-shape/catalyst-chat-ui/open-move";
import { readLastBuildScope, showOwnerInStudio } from "@work-shape/catalyst-chat-ui/build-area";
import type { WorkspaceRoute } from "@work-shape/catalyst-chat-ui/shell";
import type { AssetOpen } from "@work-shape/catalyst-chat-ui/subject-run";

// The navigation rule of the agent's opens (navigation-and-layout.md 4.7b, checks 27 and 28;
// platform-access.md check 46).

const WS = "w1";
const CONVERSATION = "c1";
const chatRoute: WorkspaceRoute = {
  kind: "conversation",
  collaborationWorkspaceId: WS,
  conversationId: CONVERSATION
};
const settings: WorkspaceRoute = { kind: "settings", group: "you", page: "profile" };
const workflowPage = (workflow: string): WorkspaceRoute => ({
  kind: "workflow",
  collaborationWorkspaceId: WS,
  workflow
});
const appPage = (app: string): WorkspaceRoute => ({
  kind: "app-edit",
  collaborationWorkspaceId: WS,
  app
});

function open(kind: string, name: string, callId: string, awaitsPerson = false): AssetOpen {
  return { subject: { kind, name }, title: name, callId, awaitsPerson };
}

function plan(opens: AssetOpen[], overrides: Partial<Parameters<typeof planOpenMoves>[0]> = {}) {
  return planOpenMoves({
    runId: "run1",
    opens,
    storedSubject: undefined,
    workspaceId: WS,
    handled: new Set(),
    sentHere: true,
    live: true,
    here: chatRoute,
    conversationId: CONVERSATION,
    movedTo: new Set(),
    movedInRun: false,
    ...overrides
  });
}

describe("where an open may take the person", () => {
  it("follows from the chat route, the subject's page, a page an open moved to and the New list", () => {
    const place = {
      conversationId: CONVERSATION,
      subjectPage: workflowPage("intake"),
      movedTo: new Set(["/w/w1/apps/calculator/edit"]),
      startedFrom: "/w/w1/workflows"
    };
    expect(placeFollowsOpens({ ...place, here: chatRoute })).toBe(true);
    expect(placeFollowsOpens({ ...place, here: workflowPage("intake") })).toBe(true);
    expect(
      placeFollowsOpens({ ...place, here: { kind: "workflows", collaborationWorkspaceId: WS } })
    ).toBe(true);
    // A page the person went to on their own, and another conversation's chat route.
    expect(placeFollowsOpens({ ...place, here: settings })).toBe(false);
    expect(placeFollowsOpens({ ...place, here: workflowPage("other") })).toBe(false);
    expect(placeFollowsOpens({ ...place, here: { ...chatRoute, conversationId: "c2" } })).toBe(
      false
    );
  });
});

describe("the moves of a run's opens", () => {
  it("moves the tab that sent the message and watches the run, from the chat route", () => {
    expect(plan([open("workflow", "intake", "o1")])).toEqual({
      handled: ["o1"],
      moves: [{ page: workflowPage("intake"), replace: false }]
    });
  });

  it("names the owner of an asset whose page is in Studio, and sets Studio to it on the way", () => {
    const store: AssetOpen = { ...open("data_store", "orders", "o1"), owner: WS };
    const page: WorkspaceRoute = { kind: "build-asset", assetKind: "data-stores", name: "orders" };
    expect(plan([store])).toEqual({
      handled: ["o1"],
      moves: [{ page, replace: false, owner: WS }]
    });
    showOwnerInStudio(WS);
    expect(readLastBuildScope()).toBe(WS);
    showOwnerInStudio(undefined);
    expect(readLastBuildScope()).toBe("instance");
  });

  it("moves from the list page a New button started the conversation on (NAV-2)", () => {
    const list: WorkspaceRoute = { kind: "workflows", collaborationWorkspaceId: WS };
    const opens = [open("workflow", "new-close", "o1")];
    expect(plan(opens, { here: list, startedFrom: "/w/w1/workflows" })).toEqual({
      handled: ["o1"],
      moves: [{ page: workflowPage("new-close"), replace: false }]
    });
    // Without that start the list is a page the person chose.
    expect(plan(opens, { here: list })).toEqual({ handled: ["o1"], moves: [] });
  });

  it("moves nothing in a second tab, on a replayed run, or from a page the person chose", () => {
    const opens = [open("workflow", "intake", "o1")];
    for (const elsewhere of [{ sentHere: false }, { live: false }, { here: settings }]) {
      expect(plan(opens, elsewhere)).toEqual({ handled: ["o1"], moves: [] });
    }
  });

  it("adds one step to the history for the first open of a run and replaces it after", () => {
    expect(plan([open("workflow", "intake", "o1"), open("app", "calculator", "o2")])).toEqual({
      handled: ["o1", "o2"],
      // The second open follows from the page the first one moved to.
      moves: [
        { page: workflowPage("intake"), replace: false },
        { page: appPage("calculator"), replace: true }
      ]
    });
    // An open that arrives later in the same run takes the place of the step as well.
    expect(
      plan([open("workflow", "intake", "o1"), open("app", "calculator", "o2")], {
        handled: new Set(["o1"]),
        here: workflowPage("intake"),
        movedTo: new Set(["/w/w1/workflows/intake"]),
        movedInRun: true
      }).moves
    ).toEqual([{ page: appPage("calculator"), replace: true }]);
  });

  it("adds no step to the history for a person already on the asset's page", () => {
    expect(
      plan([open("workflow", "intake", "o1")], {
        storedSubject: { kind: "workflow", name: "intake" },
        here: workflowPage("intake")
      })
    ).toEqual({ handled: ["o1"], moves: [] });
  });

  it("weighs each open once", () => {
    expect(plan([open("workflow", "intake", "o1")], { handled: new Set(["o1"]) })).toEqual({
      handled: [],
      moves: []
    });
  });

  it("moves from the page of the conversation's subject", () => {
    expect(
      plan([open("app", "calculator", "o1")], {
        storedSubject: { kind: "workflow", name: "intake" },
        here: workflowPage("intake")
      }).moves
    ).toEqual([{ page: appPage("calculator"), replace: false }]);
  });

  it("never moves for an open that waits for the person, even where all else holds (check 46)", () => {
    expect(plan([open("agent", "helper", "o1", true)])).toEqual({ handled: ["o1"], moves: [] });
  });
});

describe("the offer to go to an opened asset", () => {
  const opens = [open("workflow", "intake", "o1")];

  it("is the last open while the person is not on its page", () => {
    expect(pendingOpen({ opens, storedSubject: undefined, workspaceId: WS, here: settings })).toBe(
      opens[0]
    );
    expect(
      pendingOpen({
        opens,
        storedSubject: undefined,
        workspaceId: WS,
        here: workflowPage("intake")
      })
    ).toBeUndefined();
    expect(
      pendingOpen({ opens: [], storedSubject: undefined, workspaceId: WS, here: settings })
    ).toBeUndefined();
  });

  it("stays for an open that waits for the person until it is the subject", () => {
    const waiting = [open("agent", "helper", "o1", true)];
    const onPage: WorkspaceRoute = { kind: "build-asset", assetKind: "agents", name: "helper" };
    expect(
      pendingOpen({ opens: waiting, storedSubject: undefined, workspaceId: WS, here: onPage })
    ).toBe(waiting[0]);
    expect(
      pendingOpen({
        opens: waiting,
        storedSubject: { kind: "agent", name: "helper" },
        workspaceId: WS,
        here: onPage
      })
    ).toBeUndefined();
  });
});

describe("the last run the offer stands for", () => {
  const finalOf = (runId: string) => ({
    metadata: {
      agentRuntime: { version: 1, kind: "assistant_final", runId, finishStatus: "completed" }
    }
  });
  const partsOf = (name: string) => [
    {
      type: "tool_call",
      toolName: "platform.assets.open",
      toolCallId: `call-${name}`,
      state: "output_available",
      output: { kind: "app", name, title: name }
    }
  ];
  const watched = (id: string, status: string, name: string) => ({
    run: { id },
    projection: { status, parts: partsOf(name) }
  });

  it("is the run the thread watches while it goes, or when it is the last", () => {
    expect(
      lastRunParts({
        activeRun: watched("r2", "running", "live"),
        messages: [finalOf("r1")],
        completedRunProjections: { r1: { parts: partsOf("ended") } }
      })
    ).toEqual(partsOf("live"));
    expect(
      lastRunParts({
        activeRun: watched("r1", "completed", "seen"),
        messages: [finalOf("r1")],
        completedRunProjections: {}
      })
    ).toEqual(partsOf("seen"));
  });

  it("is the ended run read from the thread in a second tab, after a reload or a later run", () => {
    expect(
      lastRunParts({
        activeRun: undefined,
        messages: [finalOf("r1"), finalOf("r2")],
        completedRunProjections: {
          r1: { parts: partsOf("first") },
          r2: { parts: partsOf("second") }
        }
      })
    ).toEqual(partsOf("second"));
    expect(
      lastRunParts({
        activeRun: watched("r1", "completed", "first"),
        messages: [finalOf("r1"), finalOf("r2")],
        completedRunProjections: { r2: { parts: partsOf("second") } }
      })
    ).toEqual(partsOf("second"));
    expect(
      lastRunParts({ activeRun: undefined, messages: [], completedRunProjections: {} })
    ).toBeUndefined();
  });
});
