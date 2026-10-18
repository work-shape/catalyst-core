// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformContext } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  AppEdit,
  AppsHostProvider,
  AppsPage,
  AppView,
  resolveAppRights,
  SaveAsAppAction,
  type AppsHost
} from "@work-shape/catalyst-chat-ui/apps";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { appsContext as contextWith } from "./chat-ui-build-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";

// UI-FIX-1: what the Apps area offers follows the rights the instance names. An App belongs to
// a workspace, so Build, New and Save as app follow what the reader holds in the open
// workspace, never in another one. Edit, Publish and Delete of one App follow what the
// instance says the reader may do to that App when it is read.

const { t } = createTranslationContext("en");
const OPEN = "cw_open";
const OTHER = "cw_other";
const ALL_APP_RIGHTS = ["app.read", "app.write", "app.publish", "app.delete"];

/** The record of the App as `assets.get` answers it, with what the reader may do to it. */
function appRecord(allowed: readonly ("write" | "delete" | "publish")[]) {
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

/**
 * Mounts a part of the Apps area as the shell does: with the rights it resolves from the
 * platform context for the open workspace, against an instance that holds one App.
 */
async function mount(
  node: ReactNode,
  context: PlatformContext,
  allowed: readonly ("write" | "delete" | "publish")[] = [],
  /** Settles when the instance answers the App's record. */
  recordAnswered: Promise<void> = Promise.resolve()
): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === apiOperations["assets.list"].path.replace(":kind", "app"))
      return Response.json({ items: [] });
    if (
      path === apiOperations["assets.get"].path.replace(":kind", "app").replace(":name", "fees")
    ) {
      await recordAnswered;
      return Response.json(appRecord(allowed));
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
    showRoute: () => undefined,
    startChat: () => undefined
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
              createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node)
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
    vi.unstubAllGlobals();
  });
  return container;
}

function buttonNamed(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(label)
  );
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
    const view = await mount(createElement(AppView, { app: "fees" }), context, [
      "write",
      "publish"
    ]);
    await shows(view, "Fees");
    await vi.waitFor(() => expect(buttonNamed(view, t("apps.edit"))).toBeDefined(), {
      timeout: CONDITION_WAIT_MS
    });

    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, [
      "write",
      "publish"
    ]);
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(false), {
      timeout: CONDITION_WAIT_MS
    });
    // The head of a writer's draft, which a reader who may not write it is not shown.
    expect(draft.textContent).toContain(t("apps.draftRevision", { number: 3 }));
  });

  it("says nothing of the draft to such a reader before the instance answers", async () => {
    const context = contextWith({ [OPEN]: ["app.read"] });
    let answer = () => undefined as void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const draft = await mount(
      createElement(AppEdit, { app: "fees" }),
      context,
      ["write", "publish"],
      answered
    );
    expect(draft.textContent).not.toContain(t("apps.draftUnavailable"));
    await act(async () => answer());
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(false), {
      timeout: CONDITION_WAIT_MS
    });
  });

  it("holds Publish where the App allows its writer no publish, whatever the workspace grants", async () => {
    const context = contextWith({ [OPEN]: ALL_APP_RIGHTS });
    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, ["write"]);
    await vi.waitFor(() => expect(buttonNamed(draft, t("apps.publish"))?.disabled).toBe(true), {
      timeout: CONDITION_WAIT_MS
    });
  });

  it("offers a reader who may change nothing of the App neither Edit nor its draft", async () => {
    const context = contextWith({ [OPEN]: ALL_APP_RIGHTS });
    const view = await mount(createElement(AppView, { app: "fees" }), context, []);
    await shows(view, "Fees");
    expect(buttonNamed(view, t("apps.edit"))).toBeUndefined();

    const draft = await mount(createElement(AppEdit, { app: "fees" }), context, []);
    await shows(draft, t("apps.draftUnavailable"));
    expect(buttonNamed(draft, t("apps.publish"))).toBeUndefined();
    expect(draft.textContent).not.toContain(t("apps.draftRevision", { number: 3 }));
  });
});
