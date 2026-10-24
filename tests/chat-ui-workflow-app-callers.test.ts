// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationProvider } from "./support/chat-ui/shared";
import { WorkflowsPageView, toWorkflowListItem } from "@work-shape/catalyst-chat-ui/workflows";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// A Workflow's card names the Apps that start it, as the instance's list of Workflows names
// them: two by name, the rest counted, each name a link to its App. No line where none does.

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const noop = () => undefined;

type OpenRoute = Parameters<typeof WorkflowsPageView>[0]["onOpenRoute"];

const app = (name: string, title: string, workspaceId?: string) => ({
  name,
  title,
  scope:
    workspaceId === undefined
      ? { kind: "instance" as const }
      : { kind: "workspace" as const, workspaceId }
});

function show(
  appCallers: ReturnType<typeof app>[] | undefined,
  { locale = "en", onOpenRoute = noop }: { locale?: "en" | "de"; onOpenRoute?: OpenRoute } = {}
) {
  const rows = [
    toWorkflowListItem(
      { id: "notify-clients", name: "Notify clients" },
      appCallers === undefined ? undefined : { appCallers }
    )
  ];
  act(() => {
    root.render(
      createElement(
        TranslationProvider,
        { locale, children: null },
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(WorkflowsPageView, {
            workspaceId: "cw_1",
            list: {
              rows,
              failed: false,
              hasMore: false,
              loadingMore: false,
              loadMore: noop,
              retry: noop
            },
            now: new Date("2026-10-24T09:00:00.000Z"),
            runsAvailable: true,
            onOpenRoute,
            onStart: noop
          })
        )
      )
    );
  });
  return host.querySelector("[data-workflow-app-callers]");
}

describe("the Apps on a Workflow's card", () => {
  it("names one App, a link to it in the workspace that owns it", () => {
    const opened: unknown[] = [];
    const line = show([app("orders", "Orders", "cw_2")], {
      onOpenRoute: (route) => opened.push(route)
    });
    expect(line?.textContent).toBe("Started by the app “Orders”");
    const links = [...(line?.querySelectorAll("a") ?? [])];
    expect(links.map((link) => link.textContent)).toEqual(["Orders"]);
    expect(links[0]?.getAttribute("href")).toContain("/w/cw_2/");
    act(() => links[0]?.click());
    expect(opened).toEqual([{ kind: "app", collaborationWorkspaceId: "cw_2", app: "orders" }]);
  });

  it("joins two Apps as the reader's language joins a list", () => {
    const apps = [app("intake", "Client intake"), app("orders", "Orders")];
    expect(show(apps)?.textContent).toBe("Started by the apps “Client intake” and “Orders”");
    expect(show(apps, { locale: "de" })?.textContent).toBe(
      "Gestartet von den Apps „Client intake“ und „Orders“"
    );
    expect(show([app("orders", "Orders")], { locale: "de" })?.textContent).toBe(
      "Gestartet von der App „Orders“"
    );
  });

  // English lists as Intl.ListFormat writes them for "en", with a comma before "and".
  it("names two Apps and counts the rest", () => {
    const apps = [app("a", "Alpha"), app("b", "Beta"), app("c", "Gamma"), app("d", "Delta")];
    const line = show(apps);
    expect(line?.textContent).toBe("Started by the apps “Alpha”, “Beta”, and 2 more");
    expect([...(line?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual([
      "Alpha",
      "Beta"
    ]);
    expect(show(apps, { locale: "de" })?.textContent).toBe(
      "Gestartet von den Apps „Alpha“, „Beta“ und 2 weiteren"
    );
  });

  it("says nothing where no App starts the Workflow", () => {
    expect(show(undefined)).toBeNull();
    expect(show([])).toBeNull();
  });
});
