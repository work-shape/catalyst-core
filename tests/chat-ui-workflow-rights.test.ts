// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@work-shape/catalyst-api-client";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  createInstanceSource,
  resolveWorkflowRights,
  WorkflowPage,
  WorkflowRunPage,
  WorkflowRunsPage,
  WorkflowsHostProvider,
  WorkflowsPage,
  WorkflowsSourceProvider,
  workspaceRoutePath,
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import {
  DockPageChatProvider,
  type DockPageChat
} from "@work-shape/catalyst-chat-ui/dock-page-chat";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { workflowsContext } from "./chat-ui-build-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { runsReadable, workflowRightsOn } from "./support/chat-ui";
import { recordedApiClient, type RecordedApiCall } from "./support/recorded-api-client";

// UI-FIX-2: what the Workflow screens offer follows what the instance says the reader may do
// to each Workflow, by its asset's `allowed`. Where a record says nothing, the owner's rights
// stand: the instance's for a Workflow the instance owns. Write on one Workflow offers that
// one's draft and no other. The runs of a Workflow are offered to who may read it, never for
// writing, publishing or starting it; starting follows the engine's own answer.

const { t } = createTranslationContext("en");
const OPEN = "cw_open";
const VIEWER = "user_viewer";

type Verb = "read" | "write" | "publish" | "delete";

/** One Workflow of the instance, as far as a test names it. */
interface Held {
  /** What the asset says the reader may do to it. Absent: the record says nothing. */
  allowed?: readonly Verb[];
  /** Whether a revision is published. Its draft is one revision ahead of it. */
  published?: boolean;
  /** What the engine's list names for the reader. Absent or empty: the engine lists it not. */
  actions?: readonly ("workflow.read" | "workflow.use")[];
  /** The engine names a latest run. */
  ran?: boolean;
  /** The workspace that owns it (WS-OWN-1b). Absent: the instance. */
  owner?: string;
}

const manifestOf = (name: string) => ({
  id: name,
  name: titleOf(name),
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "summary", name: "Write the summary", type: "operation", operation: "crm.list" }
  ]
});

function titleOf(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The asset of a Workflow, as `assets.list` (row) or `assets.get` (record) answers it. */
function assetOf(name: string, held: Held, record: boolean) {
  const published = held.published ?? true;
  return {
    id: `asset_${name}`,
    kind: "workflow",
    name,
    title: titleOf(name),
    scope:
      held.owner === undefined
        ? { kind: "instance" }
        : { kind: "workspace", workspaceId: held.owner },
    revision: 3,
    draftRevision: 3,
    ...(published ? { publishedRevision: 2 } : {}),
    ...(held.allowed === undefined ? {} : { allowed: [...held.allowed] }),
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-17T09:00:00.000Z",
    ...(record ? { config: { name, manifest: manifestOf(name) } } : {})
  };
}

const runOf = (workflow: string, status: "running" | "failed") => ({
  id: "wfr_1",
  rootRunId: "wfr_1",
  depth: 0,
  workflow,
  definitionRevisionId: "rev_2",
  mode: "live" as const,
  trigger: "manual" as const,
  status,
  principal: { id: "sp_1", name: "workflow-runner", displayLabel: "Workflow runner" },
  // Another person started it: cancelling it is the writer's, not the starter's.
  startedBy: { kind: "user" as const, id: "user_other", label: "Ada Lovelace" },
  stepRunCount: 1,
  deadlineAt: "2026-10-17T10:00:00.000Z",
  createdAt: "2026-10-17T09:00:00.000Z",
  startedAt: "2026-10-17T09:00:01.000Z",
  ...(status === "failed"
    ? {
        finishedAt: "2026-10-17T09:00:42.000Z",
        error: { code: "FORBIDDEN", message: "The instance's own sentence" }
      }
    : {})
});

/** The instance, over the release's own client: the source the screens read in the shell. */
function instanceOf(workflows: Record<string, Held>, run?: ReturnType<typeof runOf>) {
  return recordedApiClient(({ operation, params, query }: RecordedApiCall) => {
    switch (operation) {
      case "workflows.list":
        return {
          items: Object.entries(workflows)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .filter(([, held]) => (held.actions ?? []).length > 0 && held.published !== false)
            .map(([name, held]) => ({
              id: name,
              name: titleOf(name),
              definitionRevisionId: "rev_2",
              ...(held.owner === undefined ? {} : { workspaceId: held.owner }),
              actions: [...(held.actions ?? [])],
              runnable: true,
              reasons: [],
              ...(held.ran === true
                ? {
                    lastRun: {
                      id: "wfr_0",
                      status: "done",
                      startedAt: "2026-10-16T09:00:00.000Z",
                      endedAt: "2026-10-16T09:01:00.000Z"
                    }
                  }
                : {})
            }))
        };
      case "assets.list":
        // A list is of one owner: the instance, or the workspace the query names.
        return {
          items: Object.entries(workflows)
            .filter(([, held]) => held.owner === query.workspaceId)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, held]) => assetOf(name, held, false))
        };
      case "assets.get": {
        const name = params.name ?? "";
        // An asset is read in the scope of its owner; in another one it is not there.
        if (workflows[name]?.owner !== query.workspaceId)
          return Response.json(
            { error: { code: "NOT_FOUND", message: "Not found", correlationId: "corr_1" } },
            { status: 404 }
          );
        return assetOf(name, workflows[name] ?? {}, true);
      }
      case "workflows.list_runs":
        return { items: run === undefined ? [] : [run] };
      case "workflows.get_run":
        return run;
      case "workflows.list_step_runs":
        return { items: [] };
      default:
        return {};
    }
  });
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
});

/** What each mounted page offers the page head's "Chat": its conversation with the agent. */
const pageChats = new Map<HTMLElement, DockPageChat | undefined>();
const offersChat = (container: HTMLElement) => pageChats.get(container) !== undefined;

/** Mounts a Workflow screen as the shell does, with the rights it resolves for the open workspace. */
async function mount(
  node: ReactNode,
  source: WorkflowsSource,
  context: PlatformContext = workflowsContext([])
): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } }
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const host: WorkflowsHost = {
    rights: resolveWorkflowRights(context, OPEN),
    viewerId: VIEWER,
    workspace: { id: OPEN, name: "Office" },
    showRoute: () => undefined,
    editWithAgent: () => Promise.resolve()
  };
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: "https://chat.example.com", children: null },
          createElement(
            WorkflowsSourceProvider,
            { source, children: null },
            createElement(
              WorkflowsHostProvider,
              { value: host, children: null },
              createElement(
                TranslationProvider,
                { locale: "en", children: null },
                createElement(
                  UiRoot,
                  { mode: "light", labels: uiLabelsEn },
                  createElement(
                    DockPageChatProvider,
                    { value: (chat) => pageChats.set(container, chat) },
                    node
                  )
                )
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    pageChats.delete(container);
    vi.unstubAllGlobals();
  });
  return container;
}

async function waitForText(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      expect(container.textContent).toContain(text);
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

const buttonTexts = (container: ParentNode) =>
  [...container.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");

const runsPath = (workflow: string) =>
  workspaceRoutePath({ kind: "workflow-runs", collaborationWorkspaceId: OPEN, workflow });

/** The addresses of the runs a page links to, by tab or by card. */
const runsLinks = (container: ParentNode) =>
  [...container.querySelectorAll("a")]
    .filter((link) => link.textContent?.trim() === t("workflows.sectionRuns"))
    .map((link) => link.getAttribute("href"));

/** The names of the Workflows whose card offers a start. */
const startedFromCards = (container: HTMLElement) =>
  [...container.querySelectorAll("button")]
    .filter((button) => button.textContent?.includes(t("workflows.startNow")))
    .map((button) => {
      const titleId = button.getAttribute("aria-describedby") ?? "";
      return container.querySelector(`[id="${titleId}"]`)?.textContent?.trim();
    });

describe("what the reader may do to one Workflow", () => {
  const ALL = { read: true, write: true, publish: true, delete: true };
  const NONE = { read: false, write: false, publish: false, delete: false };
  const rights: WorkflowsHost["rights"] = {
    instance: { ...ALL, delete: false },
    workspace: { id: OPEN, rights: ALL }
  };

  it("is what its record allows, a delete denied over every right the owner holds", () => {
    const denied = { allowed: ["read", "write", "publish"] as const, ownerWorkspaceId: OPEN };
    expect(workflowRightsOn(rights, denied)).toEqual({ ...ALL, delete: false });
    expect(workflowRightsOn(rights, { allowed: [] })).toEqual(NONE);
  });

  it("is the owner's where its record says nothing, and never another workspace's", () => {
    expect(workflowRightsOn(rights, {})).toEqual(rights.instance);
    expect(workflowRightsOn(rights, { ownerWorkspaceId: OPEN })).toEqual(ALL);
    expect(workflowRightsOn(rights, { ownerWorkspaceId: "cw_other" })).toEqual(NONE);
    // The open workspace's rights are lent to no Workflow the instance owns.
    expect(workflowRightsOn({ instance: NONE, workspace: { id: OPEN, rights: ALL } }, {})).toEqual(
      NONE
    );
  });

  it("reads runs by the read right alone", () => {
    expect(runsReadable(rights, { allowed: ["read"] })).toBe(true);
    expect(runsReadable(rights, { allowed: ["write", "publish", "delete"] })).toBe(false);
    expect(runsReadable({ instance: NONE }, {})).toBe(false);
  });
});

describe("the list of Workflows, by what the reader may do to each", () => {
  it("lists a draft to its writer or publisher alone, and a published one its writer cannot read", async () => {
    const { client } = instanceOf({
      // Published, held by write alone: the engine lists it not, its asset does.
      written: { allowed: ["write"] },
      // Never published, held by publish alone: the publisher publishes it from its page.
      proposed: { allowed: ["publish"], published: false },
      // Never published, read alone: nothing of it is the reader's to look at yet.
      glimpsed: { allowed: ["read"], published: false }
    });
    const container = await mount(createElement(WorkflowsPage), createInstanceSource(client, "k"));
    await waitForText(container, "Written");
    expect(container.textContent).toContain("Proposed");
    expect(container.textContent).not.toContain("Glimpsed");
    // Written is published: no draft badge stands on it, and nothing starts it from here.
    expect(container.textContent).toContain(t("workflows.draft.unpublished"));
    expect(
      container.textContent?.split(t("workflows.draft.unpublished")).length,
      "only the draft never published is marked so"
    ).toBe(2);
    expect(startedFromCards(container)).toEqual([]);
  });

  it("links a card to its runs for who may read them, and starts it for who may use it", async () => {
    const { client } = instanceOf({
      reader: { allowed: ["read"], actions: ["workflow.read"], ran: true },
      // Starts it, and reads none of its runs: its asset says nothing, and the instance grants none.
      starter: { actions: ["workflow.use"], ran: true },
      // Writes it and starts it, and reads none of its runs.
      builder: { allowed: ["write"], actions: ["workflow.use"], ran: true }
    });
    const container = await mount(createElement(WorkflowsPage), createInstanceSource(client, "k"));
    await waitForText(container, "Builder");
    expect(runsLinks(container)).toEqual([runsPath("reader")]);
    expect(startedFromCards(container).sort()).toEqual(["Builder", "Starter"]);
  });
});

describe("the Workflows of the open workspace beside the instance's (WS-OWN-1b)", () => {
  it("lists the open workspace's own with its chip, and none of another workspace", async () => {
    const { client } = instanceOf({
      ownflow: { allowed: ["read"], actions: ["workflow.read"], owner: OPEN },
      shared: { allowed: ["read"], actions: ["workflow.read"] },
      elsewhere: { allowed: ["read"], actions: ["workflow.read"], owner: "cw_other" }
    });
    const container = await mount(createElement(WorkflowsPage), createInstanceSource(client, "k"));
    await waitForText(container, "Ownflow");
    expect(container.textContent).toContain("Shared");
    expect(container.textContent).not.toContain("Elsewhere");
    // The chip names the open workspace on its own Workflow alone.
    expect(container.textContent?.split("Office").length).toBe(2);
  });

  it("reads and publishes a Workflow of the open workspace in that workspace's scope", async () => {
    const { client, calls } = instanceOf({
      ownflow: { allowed: ["read", "write", "publish"], published: false, owner: OPEN },
      shared: { allowed: ["read"], actions: ["workflow.read"] }
    });
    const source = createInstanceSource(client, "k");

    const view = await source.getWorkflow(OPEN, "ownflow", new AbortController().signal);
    await source.getWorkflow(OPEN, "shared", new AbortController().signal);
    await source.drafts?.publish("ownflow", 3).catch(() => undefined);

    expect(view.ownerWorkspaceId).toBe(OPEN);
    // The open workspace's list says whose each one is, so each is read once, where it is,
    // and no read answers 404.
    expect(
      calls
        .filter((call) => call.operation === "assets.get")
        .map((call) => [call.params.name, call.query.workspaceId])
    ).toEqual([
      ["ownflow", OPEN],
      ["shared", undefined]
    ]);
    const publish = calls.find((call) => call.operation === "assets.publish");
    expect(JSON.parse(publish?.body ?? "{}")).toEqual({ revision: 3, workspaceId: OPEN });
  });
});

describe("the page of a Workflow, by what the reader may do to it", () => {
  it("offers the draft of the Workflow its reader may write, and of no other", async () => {
    const { client } = instanceOf({
      granted: { allowed: ["write"] },
      sibling: { allowed: ["read"], actions: ["workflow.read"] }
    });
    const source = createInstanceSource(client, "k");
    const granted = await mount(createElement(WorkflowPage, { workflow: "granted" }), source);
    await waitForText(granted, t("workflows.draft.discard"));
    expect(offersChat(granted)).toBe(true);
    expect(buttonTexts(granted)).not.toContain(t("workflows.draft.publish"));
    // Writing it reads none of its runs.
    expect(runsLinks(granted)).toEqual([]);

    const sibling = await mount(createElement(WorkflowPage, { workflow: "sibling" }), source);
    await waitForText(sibling, "Sibling");
    expect(offersChat(sibling)).toBe(false);
    expect(buttonTexts(sibling)).not.toContain(t("workflows.draft.discard"));
    expect(runsLinks(sibling)).toEqual([runsPath("sibling")]);
  });

  it("follows the record over what the instance holds, and offers no Delete", async () => {
    const { client } = instanceOf({
      // The instance grants every right; this Workflow says it may only be read and published.
      kept: { allowed: ["read", "publish"], actions: ["workflow.read"] },
      // The record says nothing: the instance's rights stand for it.
      open: { actions: ["workflow.read"] }
    });
    const source = createInstanceSource(client, "k");
    const everything = workflowsContext([
      "workflow.read",
      "workflow.write",
      "workflow.publish",
      "workflow.delete"
    ]);
    const kept = await mount(createElement(WorkflowPage, { workflow: "kept" }), source, everything);
    await waitForText(kept, t("workflows.draft.publish"));
    expect(offersChat(kept)).toBe(false);
    expect(buttonTexts(kept)).not.toContain(t("workflows.draft.discard"));

    const open = await mount(createElement(WorkflowPage, { workflow: "open" }), source, everything);
    await waitForText(open, t("workflows.draft.discard"));
    expect(offersChat(open)).toBe(true);
    expect(buttonTexts(open)).toEqual(
      expect.arrayContaining([t("workflows.draft.publish"), t("workflows.draft.discard")])
    );
    // A Workflow's pages hold no Delete, for a reader denied it or granted it.
    for (const page of [kept, open]) {
      expect(buttonTexts(page).filter((text) => /delete/i.test(text))).toEqual([]);
    }
  });
});

describe("the runs of a Workflow, for who may read them", () => {
  it("asks for no runs where the Workflow says its reader may not read them", async () => {
    const { client, calls } = instanceOf({
      written: { allowed: ["write"], actions: ["workflow.use"] }
    });
    const container = await mount(
      createElement(WorkflowRunsPage, { workflow: "written" }),
      createInstanceSource(client, "k")
    );
    await waitForText(container, t("workflows.runs.unreadable"));
    expect(calls.map((call) => call.operation)).not.toContain("workflows.list_runs");
    expect(runsLinks(container)).toEqual([]);
    // Starting it is the engine's to say, and it says so.
    expect(buttonTexts(container).some((text) => text.includes(t("workflows.startNow")))).toBe(
      true
    );
  });

  it("lists the runs to who may read the Workflow", async () => {
    const { client, calls } = instanceOf(
      { reader: { allowed: ["read"], actions: ["workflow.read"] } },
      runOf("reader", "failed")
    );
    const container = await mount(
      createElement(WorkflowRunsPage, { workflow: "reader" }),
      createInstanceSource(client, "k")
    );
    await vi.waitFor(
      async () => {
        await act(async () => undefined);
        expect(calls.map((call) => call.operation)).toContain("workflows.list_runs");
      },
      { timeout: CONDITION_WAIT_MS }
    );
    expect(container.textContent).not.toContain(t("workflows.runs.unreadable"));
  });

  it("says once that the Workflow failed to load, and reads it again on Try again", async () => {
    const { client, calls } = instanceOf({
      reader: { allowed: ["read"], actions: ["workflow.read"] }
    });
    const instance = createInstanceSource(client, "k");
    let down = true;
    const source: WorkflowsSource = {
      ...instance,
      getWorkflow: (workspaceId, workflow, signal) =>
        down
          ? Promise.reject(new Error("The instance did not answer."))
          : instance.getWorkflow(workspaceId, workflow, signal)
    };
    const container = await mount(createElement(WorkflowRunsPage, { workflow: "reader" }), source);
    await waitForText(container, t("workflows.failed"));
    expect(container.querySelectorAll("[data-load-error]")).toHaveLength(1);
    expect(container.textContent).not.toContain(t("workflows.runs.listFailed"));
    expect(calls.map((call) => call.operation)).not.toContain("workflows.list_runs");

    down = false;
    const retry = [...container.querySelectorAll<HTMLButtonElement>("[data-load-error] button")];
    expect(retry.map((button) => button.textContent)).toEqual([uiLabelsEn.tryAgain]);
    await act(async () => retry[0]?.click());
    await vi.waitFor(
      async () => {
        await act(async () => undefined);
        expect(calls.map((call) => call.operation)).toContain("workflows.list_runs");
      },
      { timeout: CONDITION_WAIT_MS }
    );
    expect(container.querySelectorAll("[data-load-error]")).toHaveLength(0);
  });
});

describe("the page of a run, by the run's own Workflow", () => {
  // The address names a sibling the reader may do nothing to; the run names the Workflow the
  // reader writes and starts. What the page offers is that Workflow's.
  const held: Record<string, Held> = {
    granted: { allowed: ["read", "write"], actions: ["workflow.read", "workflow.use"] },
    sibling: { allowed: ["read"], actions: ["workflow.read"] }
  };

  it("offers Fix with the agent and Run again of the run's Workflow", async () => {
    const { client } = instanceOf(held, runOf("granted", "failed"));
    const container = await mount(
      createElement(WorkflowRunPage, { workflow: "sibling", run: "wfr_1" }),
      createInstanceSource(client, "k")
    );
    await waitForText(container, t("workflows.fix.withAgent"));
    expect(buttonTexts(container)).toEqual(
      expect.arrayContaining([t("workflows.fix.withAgent"), t("workflows.run.again")])
    );
  });

  it("lets the writer of the run's Workflow cancel another person's run", async () => {
    const { client } = instanceOf(held, runOf("granted", "running"));
    const container = await mount(
      createElement(WorkflowRunPage, { workflow: "sibling", run: "wfr_1" }),
      createInstanceSource(client, "k")
    );
    await waitForText(container, t("workflows.run.cancel"));
  });

  it("offers neither to a reader who only reads the run's Workflow", async () => {
    const { client } = instanceOf(
      { ...held, granted: { allowed: ["read"], actions: ["workflow.read"] } },
      runOf("granted", "running")
    );
    const container = await mount(
      createElement(WorkflowRunPage, { workflow: "granted", run: "wfr_1" }),
      createInstanceSource(client, "k")
    );
    await waitForText(container, "Granted");
    expect(buttonTexts(container)).not.toContain(t("workflows.run.cancel"));
    expect(offersChat(container)).toBe(false);
  });
});
