// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext, TranslationProvider } from "./support/chat-ui/shared";
import {
  AppEdit,
  AppsHostProvider,
  AppsPage,
  AppView,
  resolveAppRights,
  SaveAsAppAction,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import {
  DockPageChatProvider,
  type DockPageChat
} from "@work-shape/catalyst-chat-ui/dock-page-chat";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { appsContext as contextWith } from "./chat-ui-build-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

// UI-FIX-1: what the Apps area offers follows the rights the instance names. An App belongs to
// a workspace, so Build, New and Save as app follow what the reader holds in the open
// workspace, never in another one. Reading, Edit, Edit with the agent, Publish and Delete of
// one App follow what the instance says the reader may do to that App, with its row of the
// list and with its record. An instance that says nothing leaves the workspace's rights.

const { t } = createTranslationContext("en");
const OPEN = "cw_open";
const OTHER = "cw_other";
const ALL_APP_RIGHTS = ["app.read", "app.write", "app.publish", "app.delete"];

type AppVerb = "read" | "write" | "delete" | "publish";

/** The row of the App as `assets.list` answers it, with what the reader may do to it, if said. */
function appRow(allowed?: readonly AppVerb[]) {
  return {
    id: "asset_1",
    kind: "app",
    name: "fees",
    title: "Fees",
    scope: { kind: "workspace", workspaceId: OPEN },
    revision: 3,
    draftRevision: 3,
    publishedRevision: 2,
    ...(allowed === undefined ? {} : { allowed: [...allowed] }),
    updatedAt: "2026-10-17T09:00:00.000Z"
  };
}

/** The record of the App as `assets.get` answers it, with what the reader may do to it. */
function appRecord(allowed: readonly AppVerb[]) {
  return {
    id: "asset_1",
    kind: "app",
    name: "fees",
    scope: { kind: "workspace", workspaceId: OPEN },
    revision: 3,
    draftRevision: 3,
    publishedRevision: 2,
    config: { title: "Fees" },
    allowed: [...allowed],
    updatedAt: "2026-10-17T09:00:00.000Z"
  };
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
});

/** What the instance holds and answers, as far as a test names it. */
interface Instance {
  /** What the reader may do to the App, as its record says. */
  allowed?: readonly AppVerb[];
  /** Settles when the instance answers the App's record. */
  recordAnswered?: Promise<void>;
  /** The record's reading fails, while this says so. */
  recordFails?: () => boolean;
  /** The rows of the Apps list. */
  rows?: readonly ReturnType<typeof appRow>[];
  /** The address the instance names for the published App's frame, in this workspace's path. */
  previewIn?: string;
  editWithAgent?: AppsHost["editWithAgent"];
  showRoute?: AppsHost["showRoute"];
}

/**
 * Mounts a part of the Apps area as the shell does: with the rights it resolves from the
 * platform context for the open workspace, against an instance that holds one App.
 */
async function mount(
  node: ReactNode,
  context: PlatformContext,
  instance: Instance = {}
): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === apiOperations["assets.list"].path.replace(":kind", "app"))
      return Response.json({ items: instance.rows ?? [] });
    if (
      path === apiOperations["assets.get"].path.replace(":kind", "app").replace(":name", "fees")
    ) {
      await instance.recordAnswered;
      if (instance.recordFails?.() === true) {
        return Response.json({ error: { code: "INTERNAL", message: "down" } }, { status: 500 });
      }
      return Response.json(appRecord(instance.allowed ?? []));
    }
    if (
      instance.previewIn !== undefined &&
      path === apiOperations["apps.preview"].path.replace(":app", "fees")
    ) {
      return Response.json({
        url: "/frames/fees/",
        expiresAt: "2026-10-19T10:00:00.000Z",
        fileSetId: "fs_1",
        number: 2,
        pageSessionId: "ps_1",
        revision: 2,
        interfacePath: `/w/${instance.previewIn}/apps/fees`,
        heldBackHosts: []
      });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const host: AppsHost = {
    enabled: true,
    rights: resolveAppRights(context, OPEN),
    workspace: { id: OPEN, name: "Office" },
    showRoute: instance.showRoute ?? (() => undefined),
    startChat: () => undefined,
    ...(instance.editWithAgent === undefined ? {} : { editWithAgent: instance.editWithAgent })
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
            AppsHostProvider,
            { value: host, children: null },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(
                UiRoot,
                { mode: "light", labels: uiLabelsEn },
                createElement(DockPageChatProvider, { value: (chat) => (pageChat = chat) }, node)
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    pageChat = undefined;
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  return container;
}

function buttonNamed(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(label)
  );
}

/** The button or link whose whole text is `label`: "Edit" is not "Edit with the agent". */
function controlNamed(container: ParentNode, label: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>("a, button")].find(
    (control) => control.textContent?.trim() === label
  );
}

/** Opens the menu behind the button labelled `label` and answers its items. */
async function openMenu(container: ParentNode, label: string): Promise<HTMLElement[]> {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  let items: HTMLElement[] = [];
  await vi.waitFor(
    () => {
      // The menu stands outside the container, under the id its button names.
      const menu = document.getElementById(trigger?.getAttribute("aria-controls") ?? "");
      items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      expect(items.length).toBeGreaterThan(0);
    },
    { timeout: CONDITION_WAIT_MS }
  );
  return items;
}

async function menuItems(container: ParentNode, label: string): Promise<string[]> {
  return (await openMenu(container, label)).map((item) => item.textContent?.trim() ?? "");
}

/** The conversation the page on screen offers the page head's "Chat". */
let pageChat: DockPageChat | undefined;

/** Presses the page head's "Chat" on the page of an App: it starts the App's conversation. */
async function chatOnThePage(): Promise<void> {
  await vi.waitFor(() => expect(pageChat).toBeDefined(), { timeout: CONDITION_WAIT_MS });
  await act(async () => {
    await pageChat?.start({ fresh: false });
  });
}

async function shows(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(() => expect(container.textContent).toContain(text), {
    timeout: CONDITION_WAIT_MS
  });
}

/** The empty Apps list, with Build for a reader who may make an App there. */
async function emptyListOffersBuild(context: PlatformContext): Promise<boolean> {
  const page = await mount(createElement(AppsPage), context);
  await vi.waitFor(
    () =>
      expect(
        buttonNamed(page, t("apps.buildWithAgent")) !== undefined ||
          page.textContent?.includes(t("apps.emptyReadOnly"))
      ).toBe(true),
    { timeout: CONDITION_WAIT_MS }
  );
  return buttonNamed(page, t("apps.buildWithAgent")) !== undefined;
}

async function offersSaveAsApp(context: PlatformContext): Promise<boolean> {
  const header = await mount(
    createElement(SaveAsAppAction, { conversationId: "c_1", pageId: "p_1", proposedName: "Fees" }),
    context
  );
  return header.textContent?.includes(t("apps.save")) === true;
}

describe("making an App in the open workspace", () => {
  it("is offered to a reader who may write Apps in that workspace alone", async () => {
    const context = contextWith({ [OPEN]: ["app.read", "app.write"] });
    expect(await emptyListOffersBuild(context)).toBe(true);
    expect(await offersSaveAsApp(context)).toBe(true);
  });

  it("is not offered for a right in another workspace", async () => {
    const context = contextWith({ [OPEN]: ["app.read"], [OTHER]: ALL_APP_RIGHTS });
    expect(await emptyListOffersBuild(context)).toBe(false);
    expect(await offersSaveAsApp(context)).toBe(false);
  });

  it("is not offered where the open workspace lists no write, whatever the instance lists", async () => {
    // The instance names its rights in each workspace it lets them reach: one it does not
    // list there, such as one a deny in the workspace takes away, is not the reader's there.
    const context = contextWith({ [OPEN]: ["app.read"] }, ALL_APP_RIGHTS);
    expect(await emptyListOffersBuild(context)).toBe(false);
    expect(await offersSaveAsApp(context)).toBe(false);
  });

  it("is not offered to a reader who may read Apps only", async () => {
    const context = contextWith({ [OPEN]: ["app.read"] });
    expect(await emptyListOffersBuild(context)).toBe(false);
    expect(await offersSaveAsApp(context)).toBe(false);
  });
});

describe("one App", () => {
  it("offers Edit and Publish to a reader granted them on that App alone", async () => {
    const context = contextWith({ [OPEN]: ["app.read"] });
    const editWithAgent = vi.fn<NonNullable<AppsHost["editWithAgent"]>>(() => Promise.resolve());
    const instance = { allowed: ["read", "write", "publish"] as const, editWithAgent };
    const view = await mount(createElement(AppView, { app: "fees" }), context, instance);
    await shows(view, "Fees");
    await vi.waitFor(() => expect(controlNamed(view, t("apps.edit"))).toBeDefined(), {
      timeout: CONDITION_WAIT_MS
    });
    await chatOnThePage();
    expect(editWithAgent).toHaveBeenLastCalledWith("fees", { fresh: false });

    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, instance);
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(false), {
      timeout: CONDITION_WAIT_MS
    });
    // The head of a writer's draft, which a reader who may not write it is not shown.
    expect(draft.textContent).toContain(t("apps.draftSimulates"));
    editWithAgent.mockClear();
    await chatOnThePage();
    expect(editWithAgent).toHaveBeenLastCalledWith("fees", { fresh: false });
  });

  it("says nothing of the draft to such a reader before the instance answers", async () => {
    const context = contextWith({ [OPEN]: ["app.read"] });
    let answer = () => undefined as void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, {
      allowed: ["read", "write", "publish"],
      recordAnswered: answered
    });
    expect(draft.textContent).not.toContain(t("apps.draftUnavailable"));
    await act(async () => answer());
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(false), {
      timeout: CONDITION_WAIT_MS
    });
  });

  it("holds Publish where the App allows its writer no publish, whatever the workspace grants", async () => {
    const context = contextWith({ [OPEN]: ALL_APP_RIGHTS });
    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, {
      allowed: ["read", "write"]
    });
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(true), {
      timeout: CONDITION_WAIT_MS
    });
  });

  it("offers a reader who may change nothing of the App neither Edit nor its draft", async () => {
    const context = contextWith({ [OPEN]: ALL_APP_RIGHTS });
    const view = await mount(createElement(AppView, { app: "fees" }), context, {
      allowed: ["read"]
    });
    await shows(view, "Fees");
    expect(buttonNamed(view, t("apps.edit"))).toBeUndefined();

    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, {
      allowed: ["read"]
    });
    await shows(draft, t("apps.draftUnavailable"));
    expect(buttonNamed(draft, t("apps.publish"))).toBeUndefined();
    expect(draft.textContent).not.toContain(t("apps.draftSimulates"));
  });

  it("offers its details to a reader the App lets read, and not where the App denies it", async () => {
    const more = uiLabelsEn.moreActions;
    const granted = await mount(
      createElement(AppView, { app: "fees" }),
      contextWith({ [OPEN]: [] }),
      {
        allowed: ["read"]
      }
    );
    await shows(granted, "Fees");
    await vi.waitFor(
      () => expect(granted.querySelector(`button[aria-label="${more}"]`)).not.toBeNull(),
      {
        timeout: CONDITION_WAIT_MS
      }
    );
    expect(await menuItems(granted, more)).toContain(t("apps.details"));

    const denied = await mount(
      createElement(AppView, { app: "fees" }),
      contextWith({ [OPEN]: ["app.read"] }),
      { allowed: [] }
    );
    await shows(denied, "Fees");
    // Copying the link is all it is offered, as a button of its own.
    await vi.waitFor(() => expect(controlNamed(denied, t("apps.copyLink"))).toBeDefined(), {
      timeout: CONDITION_WAIT_MS
    });
    expect(denied.querySelector(`button[aria-label="${more}"]`)).toBeNull();
  });

  // ACCEPT-FIX-11 B1: an App shared with the instance, opened from team T, stays in T. The
  // instance let the reader open it there; the address its preview names may be the reader's
  // Personal Workspace, which they can open too, and moving there would leave the team.
  it("stays in the workspace it was opened from, whichever workspace its preview names", async () => {
    const showRoute = vi.fn<AppsHost["showRoute"]>();
    const view = await mount(createElement(AppView, { app: "fees" }), contextWith({ [OPEN]: [] }), {
      allowed: ["read"],
      previewIn: OTHER,
      showRoute
    });
    await vi.waitFor(() => expect(view.querySelector("iframe")).not.toBeNull(), {
      timeout: CONDITION_WAIT_MS
    });
    await shows(view, "Fees");
    expect(showRoute).not.toHaveBeenCalled();
  });

  it("says a failed reading of its draft failed, with Try again, and not that it is not there", async () => {
    let fails = true;
    const draft = await mount(
      createElement(AppEdit, { app: "fees" }),
      contextWith({ [OPEN]: ["app.read"] }),
      {
        allowed: ["read", "write", "publish"],
        recordFails: () => fails
      }
    );
    await shows(draft, t("apps.failed"));
    expect(draft.textContent).not.toContain(t("apps.draftUnavailable"));

    fails = false;
    await act(async () => controlNamed(draft, t("tryAgain"))?.click());
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(false), {
      timeout: CONDITION_WAIT_MS
    });
    expect(draft.textContent).not.toContain(t("apps.failed"));
  });
});

describe("the Apps list", () => {
  it("offers Edit on a row whose App grants the reader write, without a write in the workspace", async () => {
    const context = contextWith({ [OPEN]: ["app.read"] });
    const granted = await mount(createElement(AppsPage), context, {
      rows: [appRow(["read", "write"])]
    });
    await shows(granted, "Fees");
    expect(controlNamed(granted, t("apps.edit"))).toBeDefined();
    expect(granted.textContent).toContain(t("apps.draftChanged"));

    // An instance that says nothing of the row leaves the workspace's rights.
    const unsaid = await mount(createElement(AppsPage), context, { rows: [appRow()] });
    await shows(unsaid, "Fees");
    expect(controlNamed(unsaid, t("apps.edit"))).toBeUndefined();
  });

  it("offers no Delete on a row whose App denies it, whatever the workspace grants", async () => {
    const context = contextWith({ [OPEN]: ALL_APP_RIGHTS });
    const actionsOf = t("apps.actionsOf", { name: "Fees" });
    const denied = await mount(createElement(AppsPage), context, {
      rows: [appRow(["read", "write", "publish"])]
    });
    await shows(denied, "Fees");
    const items = await menuItems(denied, actionsOf);
    expect(items).toContain(t("apps.details"));
    expect(items).not.toContain(t("apps.delete"));
  });

  it("offers Delete on a row the instance says nothing of, where the workspace grants it", async () => {
    const context = contextWith({ [OPEN]: ALL_APP_RIGHTS });
    const unsaid = await mount(createElement(AppsPage), context, { rows: [appRow()] });
    await shows(unsaid, "Fees");
    expect(await menuItems(unsaid, t("apps.actionsOf", { name: "Fees" }))).toContain(
      t("apps.delete")
    );
  });
});
