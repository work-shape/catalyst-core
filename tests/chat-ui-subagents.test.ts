// @vitest-environment happy-dom

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createApiClient, type SubagentSummary } from "@work-shape/catalyst-api-client";
import { ToolCallPart } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import {
  answeredSubagentState,
  groupSubagents,
  requestToolCallReveal,
  ResourcesPanel,
  routeConversationId,
  subagentState,
  takeToolCallReveal,
  workspaceQueryKeys,
  WorkspaceUiStateProvider,
  workspaceRouteFromPath,
  workspaceRoutePath,
  workspaceRouteView
} from "./support/chat-ui";

// CR-1: what a person sees of a conversation's subagents. Checks 90 and 97 of
// events-workflows-and-guardrails.md for the parts the interface owns.

const API_BASE_URL = "http://127.0.0.1:1";
// Nearly the 80 characters `run_agent` takes as a description.
const LONG_DESCRIPTION =
  "Förderprogramme für energetische Sanierung in Nordrhein-Westfalen recherchieren";

function subagent(overrides: Partial<SubagentSummary> & Pick<SubagentSummary, "runId">) {
  return {
    threadId: `thread_${overrides.runId}`,
    parentRunId: "run_parent",
    toolCallId: `call_${overrides.runId}`,
    agentName: "researcher",
    description: "Marktanalyse",
    status: "running",
    startedAt: "2026-10-17T09:00:00.000Z",
    ...overrides
  } satisfies SubagentSummary;
}

describe("subagent states", () => {
  it("names a run's status as the card and the panel show it", () => {
    expect(subagentState(undefined)).toBe("starting");
    expect(subagentState("queued")).toBe("running");
    expect(subagentState("waiting_for_subagents")).toBe("running");
    expect(subagentState("cancelling")).toBe("stopping");
    expect(subagentState("completed")).toBe("completed");
    expect(subagentState("failed")).toBe("failed");
    expect(subagentState("cancelled")).toBe("cancelled");
  });

  it("reads how a subagent ended from its call's answer", () => {
    expect(answeredSubagentState({ status: "cancelled", runId: "run_1", agent: "a" })).toBe(
      "cancelled"
    );
    expect(answeredSubagentState({ runId: "run_1" })).toBeUndefined();
    expect(answeredSubagentState(undefined)).toBeUndefined();
  });

  it("groups Active and Done, newest first", () => {
    const groups = groupSubagents([
      subagent({ runId: "a", status: "completed", startedAt: "2026-10-17T09:00:00.000Z" }),
      subagent({ runId: "b", status: "running", startedAt: "2026-10-17T09:01:00.000Z" }),
      subagent({ runId: "c", status: "failed", startedAt: "2026-10-17T09:02:00.000Z" }),
      subagent({ runId: "d", status: "cancelling", startedAt: "2026-10-17T09:03:00.000Z" })
    ]);
    expect(groups.active.map((item) => item.runId)).toEqual(["d", "b"]);
    expect(groups.done.map((item) => item.runId)).toEqual(["c", "a"]);
  });

  it("brings the card of the call the thread was left for into view once", () => {
    requestToolCallReveal("call_1");
    expect(takeToolCallReveal("call_2")).toBe(false);
    expect(takeToolCallReveal("call_1")).toBe(true);
    expect(takeToolCallReveal("call_1")).toBe(false);
  });
});

describe("the address of a subagent's thread", () => {
  it("opens the thread under its conversation, in the chat", () => {
    const route = workspaceRouteFromPath("/w/cw_1/c/conv_1/subagents/thread_1");
    expect(route).toEqual({
      kind: "subagent-thread",
      collaborationWorkspaceId: "cw_1",
      conversationId: "conv_1",
      threadId: "thread_1"
    });
    expect(workspaceRoutePath(route)).toBe("/w/cw_1/c/conv_1/subagents/thread_1");
    expect(workspaceRouteView(route)).toBe("chat");
    // The conversation on the screen stays the root: its rail row and its Resources.
    expect(routeConversationId(route)).toBe("conv_1");
  });
});

describe("the card of a run_agent call", () => {
  function renderCall(
    call: { toolCallId: string; result?: unknown; isError?: boolean },
    subagents: SubagentSummary[]
  ): string {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      workspaceQueryKeys.conversationSubagents(API_BASE_URL, "standalone", "conv_1"),
      subagents
    );
    return inGerman(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: API_BASE_URL,
          children: createElement(WorkspaceUiStateProvider, {
            route: {
              kind: "conversation",
              collaborationWorkspaceId: "cw_1",
              conversationId: "conv_1"
            },
            chat: undefined,
            onRouteChange: () => undefined,
            children: createElement(
              ToolDisplayPanelProvider,
              null,
              createElement(ToolCallPart, {
                toolName: "run_agent",
                toolCallId: call.toolCallId,
                args: { description: LONG_DESCRIPTION, task: "Finde die Programme." },
                argsText: "{}",
                result: call.result,
                ...(call.isError === undefined ? {} : { isError: call.isError }),
                type: "tool-call" as const,
                status:
                  call.result === undefined
                    ? { type: "running" as const }
                    : { type: "complete" as const },
                addResult: () => undefined,
                resume: () => undefined,
                respondToApproval: () => undefined
              })
            )
          })
        })
      )
    );
  }

  it("shows a running subagent with its agent, Stop and Open", () => {
    const markup = renderCall({ toolCallId: "call_r" }, [
      subagent({ runId: "r", description: LONG_DESCRIPTION })
    ]);
    expect(markup).toContain('data-testid="subagent-card"');
    expect(markup).toContain(LONG_DESCRIPTION);
    expect(markup).toContain("researcher");
    expect(markup).toContain(">Läuft<");
    expect(markup).toContain(">Stoppen<");
    expect(markup).toContain(">Öffnen<");
  });

  it("is starting until its subagent is known, with nothing to open", () => {
    const markup = renderCall({ toolCallId: "call_new" }, []);
    expect(markup).toContain(">Startet<");
    expect(markup).not.toContain(">Öffnen<");
    expect(markup).not.toContain(">Stoppen<");
  });

  it("says how the subagent ended once the call answered, without Stop", () => {
    const markup = renderCall(
      { toolCallId: "call_f", result: { status: "failed", runId: "f", agent: "researcher" } },
      [subagent({ runId: "f", status: "failed", endedAt: "2026-10-17T09:04:00.000Z" })]
    );
    expect(markup).toContain(">Fehlgeschlagen<");
    expect(markup).toContain(">Öffnen<");
    expect(markup).not.toContain(">Stoppen<");
  });

  it("draws a refused call as any failed call", () => {
    const markup = renderCall(
      {
        toolCallId: "call_x",
        isError: true,
        result: { error: { code: "subagent_limit", message: "Too many." } }
      },
      []
    );
    expect(markup).not.toContain('data-testid="subagent-card"');
  });
});

describe("the Subagents section of the Resources panel", () => {
  function renderPanel(subagents: SubagentSummary[]): string {
    return inGerman(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: API_BASE_URL,
          children: createElement(WorkspaceUiStateProvider, {
            route: {
              kind: "conversation",
              collaborationWorkspaceId: "cw_1",
              conversationId: "conv_1"
            },
            chat: undefined,
            onRouteChange: () => undefined,
            children: createElement(
              ToolDisplayPanelProvider,
              null,
              createElement(ResourcesPanel, {
                client: createApiClient({ baseUrl: API_BASE_URL }),
                conversationId: "conv_1",
                loading: false,
                onClose() {},
                open: true,
                resources: [],
                subagents
              })
            )
          })
        })
      )
    );
  }

  it("stands first and lists Active, then Done, newest first", () => {
    const markup = renderPanel([
      subagent({ runId: "old", status: "completed", description: "Alte Analyse" }),
      subagent({
        runId: "new",
        status: "cancelled",
        description: "Neue Analyse",
        startedAt: "2026-10-17T09:05:00.000Z",
        endedAt: "2026-10-17T09:06:00.000Z"
      }),
      subagent({ runId: "live", description: LONG_DESCRIPTION })
    ]);
    expect(markup).toContain(">Subagenten<");
    expect(markup).not.toContain("Diese Unterhaltung enthält noch keine Inhalte.");
    const order = ["Aktiv", LONG_DESCRIPTION, "Erledigt", "Neue Analyse", "Alte Analyse"].map(
      (text) => markup.indexOf(text)
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(markup).toContain(">Gestoppt<");
    expect(markup).toContain(">Fertig<");
  });

  it("leaves the section out of a conversation without subagents", () => {
    expect(renderPanel([])).not.toContain(">Subagenten<");
  });
});

function inGerman(node: ReactNode): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { children: node, locale: "de" }));
}
