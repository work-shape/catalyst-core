// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations, type AppActions } from "@work-shape/catalyst-api-contract";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { listedKind, mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";

// UI-FIX-1: an asset names Knowledge Bases and Data Stores of its own owner and of the
// instance, as an agent names skills. The choosers of the agent page and of the Knowledge Base
// page ask the instance for both, and for no other workspace; an asset of the instance asks
// for the instance's own alone. The instance still decides each reference when it is saved.
// REF-OWNER: the agent page offers the actions of Apps of the agent's owner and of the
// instance, and no other workspace's, out of the one answer of `apps.actions.list`.

const OWNER = "cw_owner";

/** One published App with one action an agent can carry, owned by `workspaceId` or the instance. */
function publishedApp(name: string, workspaceId?: string): AppActions["apps"][number] {
  return {
    name,
    title: name,
    scope: workspaceId === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId },
    view: "published",
    revision: 1,
    actions: [
      {
        name: "load",
        effect: "reading",
        toolName: `app.${name}.load`,
        inputSchema: { type: "object" },
        policy: "confirm",
        agentTool: true,
        kind: "workflow",
        workflow: { name: "load" }
      }
    ]
  };
}

/** The Apps the reader may read: the instance's, the agent's workspace's and another's. */
const APP_ACTIONS: AppActions = {
  apps: [
    publishedApp("shared"),
    publishedApp("own", OWNER),
    publishedApp("elsewhere", "cw_elsewhere")
  ],
  truncated: false
};

afterEach(unmountBuildPages);

/**
 * Opens the page of `asset` in Build with the platform's own kinds, against an instance that
 * records each list it is asked for: the kind, and the workspace the list names.
 */
async function openPage(asset: BuildAsset, kindPath: string) {
  const lists: { kind: string; workspaceId: string | null }[] = [];
  const container = await mountBuildPage(asset, kindPath, (request, url) => {
    if (url.pathname === apiOperations["apps.actions.list"].path) return Response.json(APP_ACTIONS);
    const kind = listedKind(request, url);
    if (kind === undefined) return undefined;
    lists.push({ kind, workspaceId: url.searchParams.get("workspaceId") });
    return Response.json({ items: [] });
  });
  /** The owners the lists of one kind were asked for, once the page has asked for them. */
  const owners = async (kind: string, count: number) => {
    await vi.waitFor(
      () => expect(lists.filter((list) => list.kind === kind).length).toBeGreaterThanOrEqual(count),
      { timeout: CONDITION_WAIT_MS }
    );
    return [...new Set(lists.filter((list) => list.kind === kind).map((list) => list.workspaceId))];
  };
  /** The Apps whose actions the page offers, once it offers the instance's. */
  const offeredApps = async () => {
    await vi.waitFor(
      () => expect(container.querySelector('[data-app-tools="shared"]')).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    return [...container.querySelectorAll("[data-app-tools]")].map((group) =>
      group.getAttribute("data-app-tools")
    );
  };
  return Object.assign(owners, { offeredApps });
}

function agent(owner: string | undefined): BuildAsset {
  return {
    id: "asset_assistant",
    kind: "agent",
    name: "assistant",
    scope: owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner },
    revision: 3,
    config: { name: "assistant", displayName: "Assistant", instructions: "Help." },
    allowed: ["write"],
    updatedAt: "2026-10-17T01:00:00.000Z"
  };
}

function knowledgeBase(owner: string | undefined): BuildAsset {
  return {
    id: "asset_findings",
    kind: "knowledge_base",
    name: "findings-kb",
    scope: owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner },
    revision: 2,
    draftRevision: 2,
    config: {
      name: "findings-kb",
      title: "Findings",
      methods: ["structured"],
      backend: { dataStore: "findings" },
      tables: []
    },
    allowed: ["write"],
    updatedAt: "2026-10-13T10:00:00.000Z"
  };
}

describe("the Knowledge Bases an agent may name", () => {
  it("are asked for in the agent's workspace and on the instance, and nowhere else", async () => {
    const owners = await openPage(agent(OWNER), "agents");
    expect((await owners("knowledge_base", 2)).sort()).toEqual([OWNER, null].sort());
  });

  it("are asked for on the instance alone for an agent of the instance", async () => {
    const owners = await openPage(agent(undefined), "agents");
    expect(await owners("knowledge_base", 1)).toEqual([null]);
  });
});

describe("the Data Stores a Knowledge Base may read", () => {
  it("are asked for in its workspace and on the instance, and nowhere else", async () => {
    const owners = await openPage(knowledgeBase(OWNER), "knowledge-bases");
    expect((await owners("data_store", 2)).sort()).toEqual([OWNER, null].sort());
  });

  it("are asked for on the instance alone for a Knowledge Base of the instance", async () => {
    const owners = await openPage(knowledgeBase(undefined), "knowledge-bases");
    expect(await owners("data_store", 1)).toEqual([null]);
  });
});

describe("the Apps whose actions an agent may name", () => {
  it("are the agent's workspace's and the instance's, and no other workspace's", async () => {
    const page = await openPage(agent(OWNER), "agents");
    expect((await page.offeredApps()).sort()).toEqual(["own", "shared"]);
  });

  it("are the instance's alone for an agent of the instance", async () => {
    const page = await openPage(agent(undefined), "agents");
    expect(await page.offeredApps()).toEqual(["shared"]);
  });
});
