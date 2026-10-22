// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext } from "./support/chat-ui/shared";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import {
  listedKind,
  mountBuildPage,
  unmountBuildPages,
  type EditableAgentField
} from "./chat-ui-build-page-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";

// DISCOVERY-PAGING: the choosers of Build read one page of each owner and dropped the cursor,
// so the asset after the first page could never be chosen; the Add dialog of a Knowledge Base
// did the same with the files of the reader's workspace. Each now reads the next page from its
// list, with the cursor the instance handed on, and the page size is the only bound. Every
// test holds one more than a page, of each owner where an asset may name two.

const { t } = createTranslationContext("en");

/** The page size of every chooser and of the Add dialog. */
const PAGE = 50;
/** One more than a page. */
const HELD = PAGE + 1;
const OWNER = "cw_owner";
/** The agent fields the instance lets people change here: its skills and Knowledge Bases. */
const AGENT_FIELDS: readonly EditableAgentField[] = ["skillNames", "knowledgeBases"];

afterEach(unmountBuildPages);

/** The page the contract answers from `cursor` on, of `count` rows made by `row`. */
function pageOf<Row>(url: URL, count: number, row: (index: number) => Row) {
  const from = Number(url.searchParams.get("cursor") ?? "0");
  const to = Math.min(from + Number(url.searchParams.get("limit")), count);
  return {
    items: Array.from({ length: to - from }, (_, index) => row(from + index)),
    ...(to < count ? { nextCursor: String(to) } : {})
  };
}

/** Who an asset of a listed page belongs to, by the workspace the list names. */
function ownerTag(url: URL): "own" | "instance" {
  return url.searchParams.get("workspaceId") === OWNER ? "own" : "instance";
}

/**
 * An instance that holds `HELD` assets of `kind` in the owner's workspace and as many of the
 * instance's, and records every list of that kind it is asked for.
 */
function heldAssets(kind: string) {
  const lists: { owner: "own" | "instance"; cursor: string | null }[] = [];
  const answer = (request: Request, url: URL) => {
    if (url.pathname === apiOperations["apps.actions.list"].path)
      return Response.json({ apps: [], truncated: false });
    const listed = listedKind(request, url);
    if (listed === undefined) return undefined;
    if (listed !== kind) return Response.json({ items: [] });
    const owner = ownerTag(url);
    lists.push({ owner, cursor: url.searchParams.get("cursor") });
    return Response.json(
      pageOf(url, HELD, (index) => ({
        id: `asset_${kind}_${owner}_${index}`,
        kind,
        name: `${owner}-${index}`,
        title: `${owner} ${kind} ${index}`,
        scope: owner === "own" ? { kind: "workspace", workspaceId: OWNER } : { kind: "instance" },
        revision: 1,
        draftRevision: 1,
        publishedRevision: 1,
        updatedAt: "2026-10-18T09:00:00.000Z"
      }))
    );
  };
  return { lists, answer };
}

async function until(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      check();
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

/** The rows the open chooser offers, by name, without its row for the next page. */
function offered(): string[] {
  return [...document.querySelectorAll("[cmdk-item]:not([data-picker-more])")].map(
    (row) => row.textContent ?? ""
  );
}

const moreRow = () => document.querySelector<HTMLElement>("[data-picker-more]");

/**
 * Opens the chooser whose button is named `label`, reads its first page, takes its row for the
 * next page, and answers what it offers then.
 */
async function chooseFromBothPages(container: HTMLElement, label: string, kind: string) {
  await until(() =>
    expect(container.querySelector(`button[aria-label^="${label}:"]`)).not.toBeNull()
  );
  await act(async () =>
    container.querySelector<HTMLElement>(`button[aria-label^="${label}:"]`)?.click()
  );
  await until(() => expect(offered()).toHaveLength(2 * PAGE));
  expect(offered()).not.toContain(`own ${kind} ${PAGE}`);
  expect(offered()).not.toContain(`instance ${kind} ${PAGE}`);
  expect(moreRow()).not.toBeNull();

  await act(async () => moreRow()?.click());
  await until(() => expect(offered()).toHaveLength(2 * HELD));
  // The workspace's come first, then the instance's, each in the order the instance lists them.
  expect(offered().slice(PAGE - 1, PAGE + 2)).toEqual([
    `own ${kind} ${PAGE - 1}`,
    `own ${kind} ${PAGE}`,
    `instance ${kind} 0`
  ]);
  expect(offered().at(-1)).toBe(`instance ${kind} ${PAGE}`);
  // Both owners are read to their end: no row asks for more.
  expect(moreRow()).toBeNull();
}

function agent(): BuildAsset {
  return {
    id: "asset_assistant",
    kind: "agent",
    name: "assistant",
    scope: { kind: "workspace", workspaceId: OWNER },
    revision: 3,
    config: { name: "assistant", displayName: "Assistant", instructions: "Help." },
    allowed: ["write"],
    updatedAt: "2026-10-17T01:00:00.000Z"
  };
}

function knowledgeBase(config: Record<string, unknown>): BuildAsset {
  return {
    id: "asset_findings",
    kind: "knowledge_base",
    name: "findings-kb",
    scope: { kind: "workspace", workspaceId: OWNER },
    revision: 2,
    draftRevision: 2,
    publishedRevision: 2,
    config: { name: "findings-kb", title: "Findings", ...config },
    allowed: ["write"],
    updatedAt: "2026-10-13T10:00:00.000Z"
  };
}

describe("the skill chooser of an agent", () => {
  it("offers the skill after the first page of each owner, read by its cursor", async () => {
    const instance = heldAssets("skill");
    const container = await mountBuildPage(agent(), "agents", instance.answer, AGENT_FIELDS);
    await chooseFromBothPages(container, t("configSkills"), "skill");
    expect(instance.lists).toEqual(
      expect.arrayContaining([
        { owner: "own", cursor: String(PAGE) },
        { owner: "instance", cursor: String(PAGE) }
      ])
    );
  });
});

describe("the Knowledge Base chooser of an agent", () => {
  it("offers the Knowledge Base after the first page of each owner, read by its cursor", async () => {
    const instance = heldAssets("knowledge_base");
    const container = await mountBuildPage(agent(), "agents", instance.answer, AGENT_FIELDS);
    await chooseFromBothPages(container, t("knowledge.agentSection"), "knowledge_base");
    expect(instance.lists).toEqual(
      expect.arrayContaining([
        { owner: "own", cursor: String(PAGE) },
        { owner: "instance", cursor: String(PAGE) }
      ])
    );
  });
});

describe("the Data Store chooser of a Knowledge Base", () => {
  it("offers the Data Store after the first page of each owner, read by its cursor", async () => {
    const instance = heldAssets("data_store");
    const container = await mountBuildPage(
      knowledgeBase({ methods: ["structured"], backend: { dataStore: "" }, tables: [] }),
      "knowledge-bases",
      instance.answer
    );
    await chooseFromBothPages(container, t("knowledge.dataStore"), "data_store");
    expect(instance.lists).toEqual(
      expect.arrayContaining([
        { owner: "own", cursor: String(PAGE) },
        { owner: "instance", cursor: String(PAGE) }
      ])
    );
  });
});

describe("the files the Add dialog of a Knowledge Base offers", () => {
  it("offers the file after the first page, read by its cursor", async () => {
    const cursors: (string | null)[] = [];
    const filesPath = new RegExp(
      `^${apiOperations["workspaces.files.list"].path.replace(":collaborationWorkspaceId", "[^/]+")}$`,
      "u"
    );
    const container = await mountBuildPage(
      knowledgeBase({ methods: ["keyword"] }),
      "knowledge-bases",
      (_request, url) => {
        if (url.pathname.endsWith("/documents")) return Response.json({ documents: [] });
        if (!filesPath.test(url.pathname)) return undefined;
        cursors.push(url.searchParams.get("cursor"));
        return Response.json(
          pageOf(url, HELD, (index) => ({
            kind: "upload",
            id: `file_${index}`,
            name: `notes-${index}.md`,
            mimeType: "text/markdown",
            bytes: 1_000,
            updatedAt: "2026-10-18T09:00:00.000Z",
            conversation: { id: "conv_1", title: "Planning" }
          }))
        );
      }
    );
    const files = () =>
      [...document.querySelectorAll("[data-knowledge-add-file]")].map((file) =>
        file.getAttribute("data-knowledge-add-file")
      );
    const more = () => document.querySelector<HTMLElement>("[data-knowledge-add-more] button");

    await until(() => expect(container.querySelector("[data-knowledge-add]")).not.toBeNull());
    await act(async () => container.querySelector<HTMLElement>("[data-knowledge-add]")?.click());
    await until(() => expect(files()).toHaveLength(PAGE));
    expect(files()).not.toContain(`notes-${PAGE}.md`);
    expect(more()).not.toBeNull();

    await act(async () => more()?.click());
    await until(() => expect(files()).toHaveLength(HELD));
    expect(files().at(-1)).toBe(`notes-${PAGE}.md`);
    expect(more()).toBeNull();
    expect(cursors).toEqual([null, String(PAGE)]);
  });
});

describe("the Apps whose actions an agent may name", () => {
  it("offers the App after the first page, read by its cursor", async () => {
    const cursors: (string | null)[] = [];
    const container = await mountBuildPage(agent(), "agents", (request, url) => {
      if (listedKind(request, url) !== undefined) return Response.json({ items: [] });
      if (url.pathname !== apiOperations["apps.actions.list"].path) return undefined;
      cursors.push(url.searchParams.get("cursor"));
      const page = pageOf(url, HELD, (index) => ({
        name: `app-${index}`,
        title: `App ${index}`,
        scope: { kind: "instance" },
        view: "published",
        revision: 1,
        actions: [
          {
            name: "load",
            effect: "reading",
            toolName: `app.app-${index}.load`,
            inputSchema: { type: "object" },
            policy: "confirm",
            agentTool: true,
            kind: "workflow",
            workflow: { name: "load" }
          }
        ]
      }));
      return Response.json({
        apps: page.items,
        truncated: page.nextCursor !== undefined,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
      });
    });
    const apps = () =>
      [...container.querySelectorAll("[data-app-tools]")].map((group) =>
        group.getAttribute("data-app-tools")
      );
    const more = () => container.querySelector<HTMLElement>("[data-app-tools-more] button");

    await until(() => expect(apps()).toHaveLength(PAGE));
    expect(apps()).not.toContain(`app-${PAGE}`);
    await act(async () => more()?.click());
    await until(() => expect(apps()).toHaveLength(HELD));
    expect(apps().at(-1)).toBe(`app-${PAGE}`);
    expect(more()).toBeNull();
    expect(cursors).toEqual([null, String(PAGE)]);
  });
});
