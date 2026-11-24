import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import {
  ContextIndicator,
  resolveContextUsage,
  readStoredContextIndicatorPreference,
  writeStoredContextIndicatorPreference
} from "./support/chat-ui";

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

    expect(markup).toContain('stroke-dashoffset="98.5"');
  });
});
