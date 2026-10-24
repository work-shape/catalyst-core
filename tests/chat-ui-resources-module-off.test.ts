// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationResourceListItem,
  ConversationThreadSnapshot
} from "@work-shape/catalyst-api-client";
import { apiOperations, safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { ChatShell } from "@work-shape/catalyst-chat-ui/shell";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { platformContext } from "./chat-ui-build-fixtures";
import { personalWorkspace } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { workspaceRouteFromPath } from "./support/chat-ui";
import { createTestConfig } from "./support/fixtures";

// Replaces e2e/modules.spec.ts "with the resources module off > the Resources panel, its
// operation and every way to it are gone": the whole chat shell, on a conversation that holds a
// resource, against an instance whose `resources` module is on and then off. Off, the shell
// never asks for the conversation's resources, shows no Resources panel and offers no way to
// it in the palette. The refused operation itself is covered by tests/module-off.test.ts.

const API = "http://127.0.0.1:4210";
const CONVERSATION = "conv_1";
const at = "2026-10-24T10:00:00.000Z";
const admin = {
  id: "user_1",
  externalUserId: "user_1",
  displayLabel: "Admin",
  roles: ["user", "admin"],
  permissionRefs: [],
  permissions: ["audit.view"],
  clientInstanceId: "instance",
  authSource: "test"
};
const planted: ConversationResourceListItem = {
  resourceId: "planted",
  resourceType: "structured_data",
  title: "Planted table",
  createdAt: at,
  updatedAt: at,
  preview: { kind: "structured_data", structuredDataResourceId: "sdr_planted" }
};

function thread(): ConversationThreadSnapshot {
  return {
    conversation: {
      id: CONVERSATION,
      clientInstanceId: "instance",
      collaborationWorkspaceId: personalWorkspace().id,
      createdByUserId: admin.id,
      createdByExternalUserId: admin.externalUserId,
      visibility: "private",
      title: "Planted",
      status: "active",
      createdAt: at,
      updatedAt: at,
      retainedUntil: at
    },
    messages: [],
    serverTime: at,
    userState: {
      clientInstanceId: "instance",
      conversationId: CONVERSATION,
      userId: admin.id,
      updatedAt: at
    }
  };
}

function safeConfig(resources: boolean) {
  const config = createTestConfig();
  config.modules = { ...config.modules, resources: { enabled: resources } };
  return safeConfigSchema.parse(
    createSafeConfigView(
      config,
      { version: 0, agents: [], skills: [] },
      resolveInstanceModules(config, []).snapshot
    )
  );
}

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The shell on the conversation; every request it makes is recorded by its path. */
async function mountConversation(resources: boolean): Promise<{ requested: string[] }> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requested.push(path);
    if (path === apiOperations["me.get"].path) return Response.json(admin);
    if (path === apiOperations["config.get"].path) return Response.json(safeConfig(resources));
    if (path === apiOperations["workspaces.list"].path)
      return Response.json({ items: [personalWorkspace()] });
    if (path === apiOperations["platform.context.get"].path)
      return Response.json(platformContext());
    if (
      path ===
      apiOperations["conversations.thread.get"].buildPath({
        params: { conversationId: CONVERSATION }
      })
    )
      return Response.json(thread());
    if (
      path ===
      apiOperations["conversations.resources.list"].buildPath({
        params: { conversationId: CONVERSATION }
      })
    ) {
      return Response.json({ items: [planted] });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(ChatShell, {
        apiBaseUrl: API,
        administration,
        route: workspaceRouteFromPath(`/w/${personalWorkspace().id}/c/${CONVERSATION}`),
        onRouteChange: () => undefined
      })
    )
  );
  // The conversation is open: its composer stands.
  await vi.waitFor(() => required(document.querySelector('textarea[placeholder="Message"]')), {
    timeout: CONDITION_WAIT_MS
  });
  return { requested };
}

/** A button that opens or closes the Resources panel, by its accessible name. */
const resourcesButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    /Resources panel$/u.test(button.getAttribute("aria-label") ?? button.textContent ?? "")
  );

const asksForResources = (requested: string[]) =>
  requested.filter((path) => path.endsWith("/resources"));

/** Every option the palette offers once opened by its Search button, before anything is typed. */
async function paletteOptions(): Promise<string[]> {
  const search = required(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Search"
    )
  );
  await act(async () => search.click());
  return vi.waitFor(
    () => {
      const options = [...document.querySelectorAll('[role="option"]')].map(
        (option) => option.textContent ?? ""
      );
      expect(options).toContain("Instance › Modules");
      return options;
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

describe("the Resources panel and the resources module", () => {
  // The control: with the module on, the same shell asks for the resources and offers the panel.
  it("is offered on a conversation that holds a resource while the module is on", async () => {
    const page = await mountConversation(true);
    await vi.waitFor(() => expect(resourcesButtons()).not.toEqual([]), {
      timeout: CONDITION_WAIT_MS
    });
    expect(asksForResources(page.requested)).not.toEqual([]);
  });

  it("is gone with the module off: no panel, no request for it, no way to it in the palette", async () => {
    const page = await mountConversation(false);
    // Give the shell the time it took to ask with the module on.
    await vi.waitFor(
      () => expect(page.requested).toContain(apiOperations["platform.context.get"].path),
      {
        timeout: CONDITION_WAIT_MS
      }
    );
    await act(async () => new Promise((settled) => setTimeout(settled, 100)));
    expect(resourcesButtons()).toEqual([]);
    expect(document.body.textContent).not.toContain("Planted table");
    expect(asksForResources(page.requested)).toEqual([]);

    // The palette leads to the pages of this instance, and to nothing of the module.
    // Opened, it lists every page it leads to; typing only narrows that list.
    const options = await paletteOptions();
    expect(options.filter((option) => /Resources/u.test(option))).toEqual([]);
  });
});
