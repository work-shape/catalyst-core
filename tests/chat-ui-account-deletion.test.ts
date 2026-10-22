// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatShell, type WorkspaceRoute } from "@work-shape/catalyst-chat-ui/shell";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createApiClient } from "@work-shape/catalyst-api-client";
import {
  settingsPageContext,
  settingsUser,
  SETTINGS_INSTANCE_URL,
  waitForText
} from "./chat-ui-settings-fixtures";
import { platformContext } from "./chat-ui-build-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

it("signs out after account deletion is accepted for later removal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const config = settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL })).config;
  let accepted = false;
  const deleted: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === apiOperations["me.get"].path) {
      if (request.method === "DELETE") {
        accepted = true;
        deleted.push(path);
        return new Response(null, { status: 202 });
      }
      return accepted
        ? Response.json(
            {
              error: {
                code: "UNAUTHENTICATED",
                message: "User account is being deleted",
                correlationId: "test"
              }
            },
            { status: 401 }
          )
        : Response.json(settingsUser());
    }
    if (path === apiOperations["config.get"].path) return Response.json(config);
    if (path === apiOperations["platform.context.get"].path)
      return Response.json(platformContext());
    return Response.json({ items: [] });
  });
  function HostedShell() {
    const [route, setRoute] = useState<WorkspaceRoute>({
      kind: "settings",
      group: "you",
      page: "profile"
    });
    return createElement(ChatShell, {
      apiBaseUrl: SETTINGS_INSTANCE_URL,
      administration,
      route,
      onRouteChange: setRoute
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string, within: ParentNode = document) =>
    required(
      [...within.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) => item.textContent?.trim() === name
      )
    );
  try {
    await act(async () => root.render(createElement(HostedShell)));
    await vi.waitFor(
      async () => {
        await act(async () => expect(container.querySelector("h1")?.textContent).toBe("Profile"));
      },
      { timeout: CONDITION_WAIT_MS }
    );
    await act(async () => button("Delete account").click());
    const dialog = required(document.querySelector('dialog, [role="dialog"]'));
    const namedBy = required(dialog.getAttribute("aria-labelledby"));
    expect(document.getElementById(namedBy)?.textContent).toBe("Delete account?");
    await act(async () => button("Delete account", dialog).click());
    await waitForText(container, "Sign in");
    expect(container.querySelector('main[aria-label="Sign in"]')).not.toBeNull();
    expect(accepted).toBe(true);
    expect(deleted).toEqual([apiOperations["me.delete"].path]);
    expect(errors.mock.calls).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    errors.mockRestore();
    vi.unstubAllGlobals();
  }
});
