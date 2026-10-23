// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ApiUser } from "@work-shape/catalyst-api-client";
import { useControlPlaneModel } from "./support/chat-ui";
import { platformContext } from "./chat-ui-build-fixtures";
import { recordedApiClient } from "./support/recorded-api-client";
import { workspaceQueryKeys } from "./support/chat-ui";

it("opens the gallery route for an administrator and redirects a plain member without showing it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const { client } = recordedApiClient(() => platformContext());
  const apiBaseUrl = "https://chat.example";
  queryClient.setQueryData(
    workspaceQueryKeys.platformContext(apiBaseUrl, "workspace"),
    platformContext()
  );
  const goToDefaultChat = vi.fn();
  const noop = () => undefined;
  const user: ApiUser = {
    id: "usr_admin",
    clientInstanceId: "client",
    externalUserId: "admin",
    displayLabel: "Admin",
    authSource: "standalone",
    roles: ["admin"],
    permissionRefs: [],
    permissions: ["users.manage"]
  };
  function Route({ viewer }: { viewer: ApiUser }) {
    const model = useControlPlaneModel({
      apiBaseUrl,
      authScope: "workspace",
      client,
      user: viewer,
      config: undefined,
      administration: undefined,
      collaborationWorkspaces: [],
      collaborationWorkspacesReady: true,
      settingsCollaborationWorkspace: undefined,
      selectSettingsCollaborationWorkspace: noop,
      activeCollaborationWorkspace: undefined,
      isAuthenticated: true,
      route: { kind: "ui-library" },
      view: "ui-library",
      supportedLocales: ["en"],
      activeLocale: "en",
      selectLocale: noop,
      showContextIndicator: false,
      setShowContextIndicator: noop,
      themePreference: "light",
      selectThemePreference: noop,
      goToDefaultChat,
      showRoute: noop,
      onAccountDeleted: noop,
      onCollaborationWorkspaceDeleted: noop,
      agentActions: {}
    });
    return model.showUiLibrary ? createElement("h1", null, "UI library") : null;
  }
  const render = async (viewer: ApiUser) =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Route, { viewer })
        )
      );
    });
  try {
    await render(user);
    expect(container.textContent).toBe("UI library");
    expect(goToDefaultChat).not.toHaveBeenCalled();
    await render({ ...user, id: "usr_member", roles: ["user"], permissions: [] });
    expect(container.querySelector("h1")).toBeNull();
    expect(goToDefaultChat).toHaveBeenCalledExactlyOnceWith({ replace: true });
  } finally {
    act(() => root.unmount());
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});
