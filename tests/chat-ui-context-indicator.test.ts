import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import { ContextIndicator } from "../packages/chat-ui/src/assistant/context-indicator";
import { resolveContextUsage } from "../packages/chat-ui/src/assistant/context-usage";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { UserSettingsPanel } from "../packages/chat-ui/src/control-plane/user-settings-panel";
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
        { children: null, locale: "de" },
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
        { children: null, locale: "en" },
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

  it("updates the estimate from active-run text without waiting for message completion", () => {
    const messages = [
      {
        id: "msg_user",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "user" as const,
        text: "A".repeat(400),
        createdAt: "2026-07-30T10:00:00.000Z"
      }
    ];

    const beforeDelta = resolveContextUsage(messages, 270_000, {
      runId: "run_test",
      text: ""
    });
    const afterDelta = resolveContextUsage(messages, 270_000, {
      runId: "run_test",
      text: "B".repeat(400)
    });

    expect(beforeDelta?.inputTokens).toBe(104);
    expect(afterDelta?.inputTokens).toBe(208);
  });

  it("does not double-count an active run once its final message is persisted", () => {
    const usage = resolveContextUsage(
      [
        {
          id: "msg_assistant",
          conversationId: "conv_test",
          clientInstanceId: "client_test",
          role: "assistant",
          text: "B".repeat(400),
          createdAt: "2026-07-30T10:00:00.000Z",
          metadata: {
            agentRuntime: {
              version: 1,
              kind: "assistant_final",
              runId: "run_test",
              finishStatus: "completed",
              modelContext: {
                inputTokens: 1_000,
                compactThresholdTokens: 270_000,
                compacted: false
              }
            }
          }
        }
      ],
      270_000,
      {
        runId: "run_test",
        text: "B".repeat(400)
      }
    );

    expect(usage?.inputTokens).toBe(1_104);
  });

  it("shows fractional low usage instead of freezing the ring at whole percentages", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ContextIndicator, {
          inputTokens: 4_050,
          compactThresholdTokens: 270_000
        })
      )
    );

    expect(markup).toContain("Context window: 1.5% full");
    expect(markup).toContain('stroke-dashoffset="98.5"');
  });
});
