// @vitest-environment happy-dom

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  DockCreationScopeProvider,
  DockPageChatProvider,
  useOfferDockCreationScope,
  useOfferDockPageChat,
  type DockCreationScope,
  type DockPageChat
} from "@work-shape/catalyst-chat-ui/dock-page-chat";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  BuildWithAgentDialog,
  creationTargetLine,
  dockCreationTarget,
  dockKindOfRoute,
  readLastDockConversation,
  storeLastDockConversation,
  useWorkspaceDock,
  workspaceShortcutLabel
} from "./support/chat-ui";

// Studio chat entry (docs/planning/specs/studio-chat-entry.md): one "Chat" in every page head
// opens the dock from anywhere. It brings back the dock's last conversation, also after a
// reload; on an asset's page it starts the page's own conversation; the empty dock says where
// a new asset will be created.

type WorkspaceRoute = Parameters<typeof useWorkspaceDock>[0]["route"];
type Dock = ReturnType<typeof useWorkspaceDock>["dock"];
const LIST: WorkspaceRoute = { kind: "build-kind", assetKind: "agents" };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storeLastDockConversation(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  storeLastDockConversation(undefined);
  vi.unstubAllGlobals();
});

/** The shell's dock on a page whose address holds `chat`, as the router keeps it. */
function mountDock(chat: string | undefined): { current(): Dock } {
  let dock: Dock | undefined;
  function Shell(): ReactNode {
    const [address, setAddress] = useState(chat);
    dock = useWorkspaceDock({
      route: LIST,
      chat: address,
      onRouteChange: (_route, options) => setAddress(options?.chat)
    }).dock;
    return null;
  }
  act(() => root.render(createElement(Shell)));
  return {
    current: () => {
      if (dock === undefined) throw new Error("The shell did not render");
      return dock;
    }
  };
}

describe("the dock's last conversation", () => {
  it("comes back after a close, and after a reload with the dock closed", () => {
    const shell = mountDock("conv_1");
    expect(shell.current().open).toBe(true);
    act(() => shell.current().close());
    expect(shell.current().open).toBe(false);
    expect(shell.current().last).toBe("conv_1");
    // Only the id is kept, in this browser.
    expect(readLastDockConversation()).toBe("conv_1");

    // A reload: the address names no conversation, the browser still holds the last one.
    act(() => root.unmount());
    root = createRoot(container);
    const reloaded = mountDock(undefined);
    expect(reloaded.current().open).toBe(false);
    expect(reloaded.current().last).toBe("conv_1");
    act(() => reloaded.current().reopen());
    expect(reloaded.current().open).toBe(true);
    expect(reloaded.current().conversationId).toBe("conv_1");
  });

  it("is forgotten when it can no longer be read", () => {
    const shell = mountDock("conv_gone");
    act(() => shell.current().forgetLast());
    expect(shell.current().last).toBeUndefined();
    expect(readLastDockConversation()).toBeUndefined();
  });
});

describe("the conversation a page offers its Chat", () => {
  function Offering({ start }: { start: DockPageChat["start"] | undefined }): ReactNode {
    useOfferDockPageChat(start);
    return null;
  }

  it("stands while the page stands, and goes with it", async () => {
    let offered: DockPageChat | undefined;
    const start = vi.fn(async () => undefined);
    const render = (shown: boolean, pageStart: DockPageChat["start"] | undefined) =>
      act(() =>
        root.render(
          createElement(
            DockPageChatProvider,
            { value: (chat) => (offered = chat) },
            shown ? createElement(Offering, { start: pageStart }) : null
          )
        )
      );
    render(true, start);
    expect(offered).toBeDefined();
    await act(async () => {
      await offered?.start({ fresh: true });
    });
    expect(start).toHaveBeenCalledWith({ fresh: true });
    // A reader who may not change the asset is offered none.
    render(true, undefined);
    expect(offered).toBeUndefined();
    render(true, start);
    render(false, start);
    expect(offered).toBeUndefined();
  });
});

describe("where Studio tells the chat it builds", () => {
  function Offering({ scope }: { scope: DockCreationScope | undefined }): ReactNode {
    useOfferDockCreationScope(scope);
    return null;
  }

  it("is the owner Studio is set to while the page stands, and nothing once it goes", () => {
    const heard: (DockCreationScope | undefined)[] = [];
    // The shell hears with one function, as its state's setter is one.
    const hear = (offered: DockCreationScope | undefined) => heard.push(offered);
    const render = (shown: boolean, scope: DockCreationScope | undefined) =>
      act(() =>
        root.render(
          createElement(
            DockCreationScopeProvider,
            { value: hear },
            shown ? createElement(Offering, { scope }) : null
          )
        )
      );
    const team: DockCreationScope = {
      owner: "workspace",
      workspaceId: "cws_team",
      workspaceName: "Team Vertrieb"
    };
    render(true, team);
    expect(heard.at(-1)).toEqual(team);
    // The same owner again tells nothing new.
    const told = heard.length;
    render(true, { ...team });
    expect(heard).toHaveLength(told);
    render(true, { owner: "instance", mayCreate: true });
    expect(heard.at(-1)).toEqual({ owner: "instance", mayCreate: true });
    render(false, undefined);
    expect(heard.at(-1)).toBeUndefined();
  });
});

describe("where the empty dock says a new asset is created", () => {
  const en = createTranslationContext("en").t;
  const de = createTranslationContext("de").t;

  it("names the conversation's workspace for kinds a workspace owns", () => {
    const target = dockCreationTarget({
      owners: ["workspace", "instance"],
      workspaceName: "Team Vertrieb"
    });
    expect(target).toEqual({ owner: "workspace", workspaceName: "Team Vertrieb" });
    if (target === undefined) return;
    expect(creationTargetLine("agent", target, de)).toBe(
      "Neue Agenten entstehen in „Team Vertrieb“."
    );
    expect(creationTargetLine("skill", target, en)).toBe(
      "New skills are created in “Team Vertrieb”."
    );
  });

  it("names the instance for kinds only the instance owns, and nothing while unknown", () => {
    const target = dockCreationTarget({ owners: ["instance"], workspaceName: "Team Vertrieb" });
    expect(target).toEqual({ owner: "instance" });
    if (target === undefined) return;
    expect(creationTargetLine("data_store", target, de)).toBe(
      "Neue Datenspeicher entstehen in der Instanz."
    );
    expect(creationTargetLine("connection", target, en)).toBeUndefined();
    expect(dockCreationTarget({ owners: undefined, workspaceName: "Team" })).toBeUndefined();
    expect(dockCreationTarget({ owners: ["workspace"], workspaceName: undefined })).toBeUndefined();
  });

  it("reads the kind from Studio's list address", () => {
    expect(dockKindOfRoute({ kind: "build-kind", assetKind: "agents" })).toBe("agent");
    expect(dockKindOfRoute({ kind: "build-kind", assetKind: "data-stores" })).toBe("data_store");
    expect(dockKindOfRoute({ kind: "build-asset", assetKind: "skills", name: "s" })).toBe("skill");
  });
});

describe("the shortcut of Chat", () => {
  it("is J with the platform's modifier", () => {
    expect(workspaceShortcutLabel("chat")).toMatch(/J$/u);
  });
});

describe("New of a kind no person writes by hand", () => {
  it("asks what the new one should do, and opens the agent with the started sentence", async () => {
    const onBuild = vi.fn();
    const onClose = vi.fn();
    act(() =>
      root.render(
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(BuildWithAgentDialog, {
              title: "New workflow",
              prompt: "Build a new workflow that ",
              onBuild,
              onClose
            })
          )
        )
      )
    );
    const brief = document.querySelector<HTMLTextAreaElement>("[data-build-with-agent-brief]");
    expect(document.body.textContent).toContain("What should it do?");
    expect(document.body.textContent).toContain(
      "The agent builds it in your chat. You review it and publish it."
    );
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(brief, "sums up open tasks on Mondays");
      brief?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const build = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Build with the agent"
    );
    await act(async () => build?.click());
    expect(onBuild).toHaveBeenCalledWith("Build a new workflow that sums up open tasks on Mondays");
    expect(onClose).toHaveBeenCalled();
  });
});
