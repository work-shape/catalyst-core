import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import type {
  ApiClient,
  ApiUser,
  CollaborationWorkspaceWithRole
} from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  SettingsPageProvider,
  type SettingsPageContextValue
} from "@work-shape/catalyst-chat-ui/settings-page-context";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";

/** The address a Settings page rendered alone takes as its instance's. */
export const SETTINGS_INSTANCE_URL = "https://chat.example.com";

export function settingsUser(overrides: Partial<ApiUser> = {}): ApiUser {
  return {
    id: "user_1",
    clientInstanceId: "client",
    authSource: "better-auth",
    externalUserId: "user_1",
    displayLabel: "Felix Pahlke",
    email: "felix@example.com",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    ...overrides
  };
}

export function sharedWorkspace(
  overrides: Partial<CollaborationWorkspaceWithRole> = {}
): CollaborationWorkspaceWithRole {
  return {
    id: "cw_shared",
    clientInstanceId: "client",
    kind: "shared",
    name: "Produktteam",
    description: "Alles rund um das Produkt",
    visibility: "discoverable",
    defaultConversationVisibility: "workspace",
    emoji: "🚀",
    accentColor: "violet",
    personalUserId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    role: "owner",
    membershipRole: "owner",
    pendingAccessRequestCount: 0,
    ...overrides
  };
}

export function personalWorkspace(): CollaborationWorkspaceWithRole {
  return sharedWorkspace({
    id: "cw_personal",
    kind: "personal",
    name: "Felix Pahlke",
    description: null,
    visibility: "private",
    emoji: null,
    accentColor: null,
    personalUserId: "user_1"
  });
}

/** What the Settings shell hands a page, for a page rendered alone against `client`. */
export function settingsPageContext(
  client: ApiClient,
  user = settingsUser()
): SettingsPageContextValue {
  const config = createTestConfig();
  return {
    apiBaseUrl: SETTINGS_INSTANCE_URL,
    authScope: "settings-test",
    client,
    user,
    config: safeConfigSchema.parse(
      createSafeConfigView(
        config,
        { version: 0, agents: [], skills: [] },
        resolveInstanceModules(config, []).snapshot
      )
    ),
    locales: ["en", "de"],
    locale: "en",
    selectLocale: () => undefined,
    showContextIndicator: false,
    setShowContextIndicator: () => undefined,
    themePreference: "light",
    selectThemePreference: () => undefined,
    workspace: undefined,
    activeWorkspace: personalWorkspace(),
    onAccountDeleted: () => undefined,
    onWorkspaceLeft: () => undefined,
    onWorkspaceDeleted: () => undefined
  };
}

/** Renders `page` into the document with a query client of its own, as the shell does. */
export async function mountPage(
  settings: SettingsPageContextValue,
  locale: "en" | "de",
  page: ReturnType<typeof createElement>
): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          SettingsPageProvider,
          { value: settings },
          createElement(
            TranslationProvider,
            { locale, children: null },
            createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, page)
          )
        )
      )
    );
  });
  return {
    container,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      queryClient.clear();
      container.remove();
      vi.unstubAllGlobals();
    }
  };
}

export async function waitForText(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => {
        expect(container.textContent).toContain(text);
      });
    },
    { timeout: CONDITION_WAIT_MS }
  );
}
