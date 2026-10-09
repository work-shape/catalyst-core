import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  shouldExpandComposer,
  shouldQueueSend
} from "../packages/chat-ui/src/assistant/assistant-composer";
import {
  createQueuedSendSettler,
  resolveSendBlock,
  type QueuedSendState,
  type SendBlock
} from "../packages/chat-ui/src/assistant/send-block";
import { ThreadWelcomeHeading } from "../packages/chat-ui/src/assistant/assistant-thread";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";

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
    messagesLoaded: true,
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
      input: { messagesLoaded: false },
      expected: { reason: "Loading conversation", loading: true }
    },
    {
      name: "the workspace refuses",
      input: { workspaceBlock: { reason: "Workspaces could not be loaded.", loading: false } },
      expected: { reason: "Workspaces could not be loaded.", loading: false }
    },
    {
      name: "a run is active",
      input: { conversationRunning: true, messagesLoaded: false },
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
      resolveSendBlock({ ...unblocked, messagesLoaded: false, noAgentsMessage: "No agents here." })
    ).toMatchObject({ loading: true });
  });
});

describe("composer send during a block", () => {
  const loading: SendBlock = { reason: "Loading workspaces…", loading: true };
  const refusals: SendBlock[] = [
    { reason: "Workspaces could not be loaded.", loading: false },
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
      queued: { text: "Hello", collaborationWorkspaceId: undefined },
      block: loading,
      composerText: "Hello",
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

  it("drops the queued message when the workspace it was written for changes", () => {
    const settle = createQueuedSendSettler();
    const state = waiting({
      queued: { text: "Hello", collaborationWorkspaceId: "workspace_a" },
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
      settle(waiting({ queued: { text: "Edited", collaborationWorkspaceId: undefined } }))
    ).toBe("drop");
    expect(
      settle(
        waiting({
          queued: { text: "Edited", collaborationWorkspaceId: undefined },
          composerText: "Edited",
          block: undefined
        })
      )
    ).toBe("send");
  });
});
