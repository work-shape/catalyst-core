import { describe, expect, it, vi } from "vitest";
import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { ContextIndicator } from "../packages/chat-ui/src/context-indicator";
import { resolveContextUsage } from "../packages/chat-ui/src/context-usage";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { UserSettingsPanel } from "../packages/chat-ui/src/user-settings-panel";
import {
  readStoredContextIndicatorPreference,
  writeStoredContextIndicatorPreference
} from "../packages/chat-ui/src/workspace-utils";

describe("chat context indicator", () => {
  it("is off by default and persists an explicit user preference", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem(key: string) {
          return storage.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          storage.set(key, value);
        }
      }
    });

    expect(readStoredContextIndicatorPreference()).toBe(false);
    writeStoredContextIndicatorPreference(true);
    expect(readStoredContextIndicatorPreference()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("renders the setting and a ring-only context trigger in both product locales", () => {
    const settingsMarkup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(UserSettingsPanel, {
          user: {
            id: "user",
            externalUserId: "user",
            displayLabel: "User",
            roles: ["user"],
            permissionRefs: [],
            permissions: [],
            clientInstanceId: "client",
            authSource: "test"
          },
          canChangePassword: false,
          updatingProfile: false,
          changingPassword: false,
          deletingAccount: false,
          locales: ["de", "en"],
          locale: "de",
          showContextIndicator: false,
          onUpdateProfile: async () => {
            throw new Error("not used");
          },
          onChangePassword: async () => undefined,
          onDeleteAccount: async () => undefined,
          onSelectLocale: () => undefined,
          onShowContextIndicatorChange: () => undefined
        })
      )
    );
    const indicatorMarkup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "en" },
        createElement(ContextIndicator, {
          inputTokens: 135_000,
          compactThresholdTokens: 270_000
        })
      )
    );

    expect(settingsMarkup).toContain("Kontextanzeige");
    expect(settingsMarkup).toContain('role="switch"');
    expect(settingsMarkup).toContain('aria-checked="false"');
    expect(indicatorMarkup).toContain("Context window: 50% full");
    expect(indicatorMarkup).not.toContain(">50%<");
  });

  it("estimates non-zero usage for conversations without a provider snapshot", () => {
    const usage = resolveContextUsage(
      [
        {
          id: "msg_user",
          conversationId: "conv_test",
          clientInstanceId: "client_test",
          role: "user",
          text: "A".repeat(4_000),
          createdAt: "2026-07-30T10:00:00.000Z"
        }
      ],
      270_000
    );

    expect(usage).toEqual({
      inputTokens: 1_004,
      compactThresholdTokens: 270_000
    });
  });
});
