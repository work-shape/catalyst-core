import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import { safeConfigSchema } from "@vivd-catalyst/api-contract";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import {
  shouldExpandComposer,
  shouldQueueSend
} from "../packages/chat-ui/src/assistant/assistant-composer";
import {
  createQueuedSendSettler,
  draftAttachmentsKey,
  resolveSendBlock,
  type QueuedSendState,
  type SendBlock
} from "../packages/chat-ui/src/assistant/send-block";
import {
  AssistantThread,
  ThreadWelcomeHeading
} from "../packages/chat-ui/src/assistant/assistant-thread";
import {
  renderToStaticMarkup as renderInUiRoot,
  TranslationProvider
} from "./chat-ui-render-harness";
import { createTestConfig } from "./support/fixtures";

const agents = [
  {
    name: "application_assistant",
    displayName: "Application Assistant",
    description: "Help with application review.",
    selectableModels: [],
    initialPrompts: []
  },
  {
    name: "research_assistant",
    displayName: "Research Assistant",
    selectableModels: [],
    initialPrompts: []
  }
];

function renderWelcomeHeading(availableAgents: typeof agents) {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
      createElement(ThreadWelcomeHeading, {
        agent: availableAgents.at(-1),
        agentDisplay: { showName: true, showDescriptions: false },
        agents: availableAgents,
        showAgent: true,
        fallbackWelcomeMessage: "How can I help?",
        onSelectAgent: () => undefined
      })
    )
  );
}

describe("assistant composer layout", () => {
  it("moves controls below the input for multiline drafts", () => {
    expect(shouldExpandComposer("First line")).toBe(false);
    expect(shouldExpandComposer("First line\nSecond line")).toBe(true);
    expect(shouldExpandComposer("A long line that wraps", true)).toBe(true);
  });

  it("returns to the compact row after the line break is removed", () => {
    expect(shouldExpandComposer("First line\n")).toBe(true);
    expect(shouldExpandComposer("First line")).toBe(false);
  });
});

describe("start page agent picker with the agent's name", () => {
  it("names the selected agent on a picker above the welcome message", () => {
    const markup = renderWelcomeHeading(agents);

    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Select agent: Research Assistant"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain(">Research Assistant<");
    expect(markup).not.toContain("Application Assistant");
    expect(markup.indexOf("Research Assistant")).toBeLessThan(markup.indexOf("How can I help?"));
  });

  it("shows no picker when there is nothing to choose", () => {
    for (const available of [agents.slice(0, 1), []]) {
      const markup = renderWelcomeHeading(available);

      expect(markup).not.toContain("<button");
      expect(markup).toContain("How can I help?");
    }
  });
});

describe("send block", () => {
  const { t } = createTranslationContext("en");
  const unblocked: Parameters<typeof resolveSendBlock>[0] = {
    sending: false,
    conversationRunning: false,
    workspaceBlock: undefined,
    snapshotStatus: "ready",
    noAgentsMessage: undefined,
    t
  };

  it("does not block a ready composer", () => {
    expect(resolveSendBlock(unblocked)).toBeUndefined();
  });

  it.each<{ name: string; input: Partial<typeof unblocked>; expected: SendBlock }>([
    {
      name: "the workspace still loads",
      input: { workspaceBlock: { reason: "Loading workspaces…", loading: true } },
      expected: { reason: "Loading workspaces…", loading: true }
    },
    {
      name: "the conversation still loads",
      input: { snapshotStatus: "loading" },
      expected: { reason: "Loading conversation", loading: true }
    },
    {
      name: "the conversation failed to load",
      input: { snapshotStatus: "error" },
      expected: { reason: "The conversation could not be loaded.", loading: false }
    },
    {
      name: "the conversation is gone",
      input: { snapshotStatus: "not_found" },
      expected: { reason: "The conversation could not be loaded.", loading: false }
    },
    {
      name: "the workspace refuses",
      input: { workspaceBlock: { reason: "Workspaces could not be loaded.", loading: false } },
      expected: { reason: "Workspaces could not be loaded.", loading: false }
    },
    {
      name: "a run is active",
      input: { conversationRunning: true, snapshotStatus: "loading" },
      expected: { reason: t("conversationStillRunning"), loading: false }
    },
    {
      name: "no agent is available",
      input: { noAgentsMessage: "No agents here." },
      expected: { reason: "No agents here.", loading: false }
    },
    {
      name: "the first message is already on its way",
      input: { sending: true, workspaceBlock: { reason: "Loading workspaces…", loading: true } },
      expected: { reason: "Loading conversation", loading: false }
    }
  ])("blocks while $name", ({ input, expected }) => {
    expect(resolveSendBlock({ ...unblocked, ...input })).toEqual(expected);
  });

  it("reports loading before the missing agents, which only show once loading ends", () => {
    expect(
      resolveSendBlock({
        ...unblocked,
        snapshotStatus: "loading",
        noAgentsMessage: "No agents here."
      })
    ).toMatchObject({ loading: true });
  });
});

describe("composer send during a block", () => {
  const loading: SendBlock = { reason: "Loading workspaces…", loading: true };
  const refusals: SendBlock[] = [
    { reason: "Workspaces could not be loaded.", loading: false },
    { reason: "The conversation could not be loaded.", loading: false },
    { reason: "No agents here.", loading: false },
    { reason: "The conversation is still running.", loading: false },
    { reason: "Wait for file upload to finish before sending.", loading: false }
  ];

  it("remembers an Enter or a click on Send while the app loads", () => {
    expect(shouldQueueSend({ sendBlock: loading, sendQueued: false, text: "Hello" })).toBe(true);
  });

  it("remembers nothing without text, without a block or when a send already waits", () => {
    expect(shouldQueueSend({ sendBlock: loading, sendQueued: false, text: "  \n" })).toBe(false);
    expect(shouldQueueSend({ sendBlock: undefined, sendQueued: false, text: "Hello" })).toBe(false);
    expect(shouldQueueSend({ sendBlock: loading, sendQueued: true, text: "Hello" })).toBe(false);
  });

  it.each(refusals)("does not remember a send refused with: $reason", (sendBlock) => {
    expect(shouldQueueSend({ sendBlock, sendQueued: false, text: "Hello" })).toBe(false);
  });

  function waiting(overrides: Partial<QueuedSendState> = {}): QueuedSendState {
    return {
      queued: { text: "Hello", collaborationWorkspaceId: undefined, attachmentsKey: "" },
      block: loading,
      composerText: "Hello",
      attachmentsKey: "",
      collaborationWorkspaceId: undefined,
      runtimeReady: true,
      ...overrides
    };
  }

  it("sends a queued message exactly once after loading", () => {
    const settle = createQueuedSendSettler();
    const state = waiting();
    const loaded = { ...state, block: undefined, collaborationWorkspaceId: "workspace_personal" };

    expect([settle(state), settle(state), settle(loaded), settle(loaded), settle(loaded)]).toEqual([
      "wait",
      "wait",
      "send",
      "wait",
      "wait"
    ]);
  });

  // A conversation switched to is "loading" until its thread arrives, then "ready" or "error".
  function threadBlock(snapshotStatus: "loading" | "ready" | "error"): SendBlock | undefined {
    return resolveSendBlock({
      sending: false,
      conversationRunning: false,
      workspaceBlock: undefined,
      snapshotStatus,
      noAgentsMessage: undefined,
      t: createTranslationContext("en").t
    });
  }

  it("sends a message written while the conversation's thread loads once, when it arrives", () => {
    const settle = createQueuedSendSettler();
    const loadingThread = waiting({ block: threadBlock("loading") });
    const arrived = { ...loadingThread, block: threadBlock("ready") };

    expect(
      shouldQueueSend({ sendBlock: loadingThread.block, sendQueued: false, text: "Hello" })
    ).toBe(true);
    expect([
      settle(loadingThread),
      settle(loadingThread),
      settle({ ...arrived, runtimeReady: false }),
      settle(arrived),
      settle(arrived),
      settle(loadingThread),
      settle(arrived)
    ]).toEqual(["wait", "wait", "wait", "send", "wait", "wait", "wait"]);
  });

  it("does not send a waiting message when the thread fails to load, nor on a later reload", () => {
    const settle = createQueuedSendSettler();
    const loadingThread = waiting({ block: threadBlock("loading") });
    const failed = { ...loadingThread, block: threadBlock("error") };

    expect(failed.block).toEqual({
      reason: "The conversation could not be loaded.",
      loading: false
    });
    // The send is forgotten, the text stays in the composer under the reason shown.
    expect([settle(loadingThread), settle(failed)]).toEqual(["wait", "drop"]);
    expect(settle({ ...loadingThread, block: threadBlock("ready") })).toBe("wait");
    expect(shouldQueueSend({ sendBlock: failed.block, sendQueued: false, text: "Hello" })).toBe(
      false
    );
  });

  it("waits for the thread runtime to take up the lifted block", () => {
    const settle = createQueuedSendSettler();
    const state = waiting({ block: undefined, runtimeReady: false });

    expect(settle(state)).toBe("wait");
    expect(settle({ ...state, runtimeReady: true })).toBe("send");
  });

  it("drops the queued message when the user edits the text, also back to the same text", () => {
    const settle = createQueuedSendSettler();
    const state = waiting();

    expect(settle({ ...state, composerText: "Hello!" })).toBe("drop");
    expect(settle({ ...state, block: undefined })).toBe("wait");
  });

  it.each(refusals)("drops the queued message when loading ends in: $reason", (block) => {
    const settle = createQueuedSendSettler();
    const state = waiting();

    expect(settle(state)).toBe("wait");
    expect(settle({ ...state, block })).toBe("drop");
    expect(settle({ ...state, block: undefined })).toBe("wait");
  });

  it("drops the queued message, not the text, when an attachment is added or removed", () => {
    const withFile = draftAttachmentsKey([{ id: "attachment_a" }]);
    const added = createQueuedSendSettler();
    const state = waiting();

    expect(added(state)).toBe("wait");
    expect(added({ ...state, attachmentsKey: withFile })).toBe("drop");
    expect(added({ ...state, block: undefined })).toBe("wait");

    const removed = createQueuedSendSettler();
    const queuedWithFile = waiting({
      queued: { text: "Hello", collaborationWorkspaceId: undefined, attachmentsKey: withFile },
      attachmentsKey: withFile
    });

    expect(removed(queuedWithFile)).toBe("wait");
    expect(removed({ ...queuedWithFile, block: undefined, attachmentsKey: "" })).toBe("drop");
  });

  it("sends a queued message whose attachments stayed as they were", () => {
    const key = draftAttachmentsKey([{ id: "attachment_a" }, { id: "attachment_b" }]);
    const settle = createQueuedSendSettler();

    expect(
      settle(
        waiting({
          queued: { text: "Hello", collaborationWorkspaceId: undefined, attachmentsKey: key },
          attachmentsKey: draftAttachmentsKey([{ id: "attachment_a" }, { id: "attachment_b" }]),
          block: undefined
        })
      )
    ).toBe("send");
  });

  it("drops the queued message when the workspace it was written for changes", () => {
    const settle = createQueuedSendSettler();
    const state = waiting({
      queued: { text: "Hello", collaborationWorkspaceId: "workspace_a", attachmentsKey: "" },
      collaborationWorkspaceId: "workspace_a"
    });

    expect(settle(state)).toBe("wait");
    expect(settle({ ...state, block: undefined, collaborationWorkspaceId: "workspace_b" })).toBe(
      "drop"
    );
  });

  it("sends a second queued message after the first was settled", () => {
    const settle = createQueuedSendSettler();

    expect(settle(waiting({ composerText: "Edited" }))).toBe("drop");
    expect(
      settle(
        waiting({
          queued: { text: "Edited", collaborationWorkspaceId: undefined, attachmentsKey: "" }
        })
      )
    ).toBe("drop");
    expect(
      settle(
        waiting({
          queued: { text: "Edited", collaborationWorkspaceId: undefined, attachmentsKey: "" },
          composerText: "Edited",
          block: undefined
        })
      )
    ).toBe("send");
  });
});

describe("the retention line above the composer", () => {
  const day = 24 * 60 * 60 * 1000;
  const noop = () => undefined;
  type Retention = SafeConfig["retention"];
  const safeConfig: SafeConfig = safeConfigSchema.parse(
    createSafeConfigView(createTestConfig(), { version: 0, agents: [], skills: [] })
  );
  const retention: Retention = {
    ...safeConfig.retention,
    conversationDays: 30,
    expireConversations: true,
    extendOnActivity: true
  };
  // What an API from before the setting answers.
  const { extendOnActivity: _since, ...olderApiRetention } = retention;

  /** A thread with one message, as an open conversation has. */
  function OpenConversation({ children }: { children: ReactNode }) {
    const runtime = useLocalRuntime(
      {
        async run() {
          return { content: [] };
        }
      },
      { initialMessages: [{ role: "user", content: [{ type: "text", text: "First message" }] }] }
    );
    return createElement(AssistantRuntimeProvider, { runtime }, children);
  }

  /** The text of the line, or nothing when the thread shows none. */
  function lineOf(input: { retention: Retention; daysLeft: number }): string | undefined {
    const markup = renderInUiRoot(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" as const },
        createElement(
          OpenConversation,
          null,
          createElement(AssistantThread, {
            config: { ...safeConfig, retention: input.retention },
            agents: [],
            selectedAgentName: undefined,
            selectableModels: [],
            selectedModelBindingId: undefined,
            selectedReasoningEffort: undefined,
            showContextIndicator: false,
            contextSnapshot: undefined,
            notice: undefined,
            retainedUntil: new Date(Date.now() + input.daysLeft * day).toISOString(),
            draftAttachments: [],
            localUploadingAttachments: [],
            sendQueued: false,
            attachmentsEnabled: false,
            attachmentAccept: "",
            messagesEnabled: true,
            messagesLoaded: true,
            composerFocusRequestId: 0,
            onCancelRun: noop,
            onSelectAgent: noop,
            onSelectModelBinding: noop,
            onSelectReasoningEffort: noop,
            onFilesSelected: noop,
            onRemoveDraftAttachment: noop,
            onRetryDraftAttachment: noop,
            onQueueSend: noop
          })
        )
      )
    );
    const line = markup.split('data-testid="conversation-retention-notice"')[1];
    return line?.match(/<div>([^<]*)<\/div>/u)?.[1];
  }

  const deletion = "Will be deleted automatically on [A-Z][a-z]+day, [A-Z][a-z]+ \\d+\\.";
  const promise = " A new message keeps this conversation\\.";

  it("says when, and that a message keeps the conversation, where a message moves the date", () => {
    expect(lineOf({ retention, daysLeft: 3 })).toMatch(new RegExp(`^${deletion}${promise}$`, "u"));
  });

  it("makes no promise where the date stands, or where an older API does not say", () => {
    const dateOnly = new RegExp(`^${deletion}$`, "u");
    expect(lineOf({ retention: { ...retention, extendOnActivity: false }, daysLeft: 3 })).toMatch(
      dateOnly
    );
    expect(lineOf({ retention: olderApiRetention, daysLeft: 3 })).toMatch(dateOnly);
  });

  it("shows nothing on an instance that deletes nothing for age", () => {
    expect(
      lineOf({ retention: { ...retention, expireConversations: false }, daysLeft: 3 })
    ).toBeUndefined();
  });

  it("shows nothing while the date is outside the warning window", () => {
    expect(lineOf({ retention, daysLeft: 7.5 })).toBeUndefined();
    expect(lineOf({ retention, daysLeft: 6.5 })).toBeDefined();
  });

  it("is gone after a message on an instance with a short period", () => {
    for (const conversationDays of [1, 3, 7, 14, 90]) {
      const short = { ...retention, conversationDays };
      // A message has just moved the date a whole period ahead.
      expect(lineOf({ retention: short, daysLeft: conversationDays })).toBeUndefined();
      expect(
        lineOf({ retention: short, daysLeft: Math.min(7, conversationDays / 2) - 0.01 })
      ).toBeDefined();
    }
  });
});
