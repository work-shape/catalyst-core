// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Message, SafeConfig } from "@work-shape/catalyst-api-client";
import {
  AGENT_RUN_COMMAND_NOT_TAKEN_CODE,
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata,
  type ToolExecutionResult
} from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  AssistantToolRegistry,
  ThreadMessage,
  ToolDecisionsProvider,
  platformFailureOfRunError,
  platformReportSetup,
  toAiSdkMessageRepository,
  toUiMessages,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// "Problem an Workshape melden" (PLATFORM-REPORT): an answer whose run hit a platform failure
// offers the report where the instance names a support address; any other failure does not.
// The dialog says what is sent, and the request carries the note and nothing of the answer.

let host: HTMLDivElement;
let root: Root;
let sent: { path: string; body: unknown }[];

const reportPath = apiOperations["platform_report.send"].path
  .replace(":conversationId", "conv_1")
  .replace(":runId", "run_1");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  sent = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || path !== reportPath) {
      return Response.json({ error: { code: "NOT_FOUND", message: "No" } }, { status: 404 });
    }
    sent.push({ path, body: await request.json() });
    return Response.json({ id: "prep_1", reportedAt: "2026-10-27T09:16:00.000Z" });
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const base = { conversationId: "conv_1", clientInstanceId: "client_test" } as const;
const QUESTION = "Bitte rechne die Rechnungen zusammen";
const ANSWER = "Die Sandbox ist nicht gestartet.";

const platformFailure: ToolExecutionResult = {
  status: "failed",
  error: {
    code: "handler_failed",
    message: "The command did not run because the platform's sandbox could not start.",
    details: { commandId: "wcmd_1", reason: "sandbox_unavailable", at: "2026-10-27T09:15:00.000Z" }
  }
};
const commandFailure: ToolExecutionResult = {
  status: "failed",
  error: {
    code: "handler_failed",
    message: "The command exited with 1",
    details: { commandId: "wcmd_1", exitCode: 1 }
  }
};

function messagesWith(result: ToolExecutionResult): Message[] {
  const toolCall = {
    toolCallId: "call_1",
    toolName: "workspace.exec",
    input: { command: "python total.py" }
  };
  return [
    {
      ...base,
      id: "msg_user",
      role: "user",
      text: QUESTION,
      createdAt: "2026-10-27T09:14:00.000Z"
    },
    {
      ...base,
      id: "msg_calls",
      role: "assistant",
      text: "",
      createdAt: "2026-10-27T09:14:30.000Z",
      metadata: createAssistantToolCallsMetadata({ runId: "run_1", toolCalls: [toolCall] })
    },
    {
      ...base,
      id: "msg_result",
      role: "tool",
      text: "",
      createdAt: "2026-10-27T09:15:00.000Z",
      metadata: createToolResultMetadata({
        runId: "run_1",
        toolCall,
        result,
        modelOutput: { text: "failed" }
      })
    },
    {
      ...base,
      id: "msg_final",
      role: "assistant",
      text: ANSWER,
      createdAt: "2026-10-27T09:15:10.000Z",
      metadata: createAssistantFinalMetadata({ runId: "run_1" })
    }
  ];
}

const transport = {
  sendMessages: async () => {
    throw new Error("This thread takes no message");
  },
  reconnectToStream: async () => null
};

function Thread({ messages, offered }: { messages: Message[]; offered: boolean }) {
  const uiMessages = toUiMessages(messages);
  const runtime = useChatRuntime({ messages: uiMessages, transport, isSendDisabled: true });
  useEffect(() => {
    runtime.thread.importExternalState(toAiSdkMessageRepository(uiMessages));
  }, [runtime]);
  const platformReport = offered
    ? { conversationId: "conv_1", instanceName: "Test instance" }
    : undefined;
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(
      ToolDecisionsProvider,
      { parts: undefined, children: null },
      createElement(
        AssistantToolRegistry,
        null,
        createElement(
          ThreadPrimitive.Root,
          null,
          createElement(ThreadPrimitive.Messages, {
            children: () => createElement(ThreadMessage, { platformReport })
          })
        )
      )
    )
  );
}

async function render(messages: Message[], offered = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: "https://api.example.test", children: null },
              createElement(Thread, { messages, offered })
            )
          )
        )
      )
    )
  );
  await settle();
}

async function settle() {
  for (let pass = 0; pass < 5; pass += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const action = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="platform-report-action"]');

describe("reporting a platform problem", () => {
  it("is offered only where the instance names a support address", () => {
    const instance: Pick<SafeConfig, "clientInstance"> = {
      clientInstance: { id: "client_test", displayName: "Test instance", environment: "test" }
    };
    const config = (
      available: boolean | undefined
    ): Pick<SafeConfig, "clientInstance" | "platformReport"> =>
      available === undefined ? instance : { ...instance, platformReport: { available } };
    expect(platformReportSetup(config(true), "conv_1")).toEqual({
      conversationId: "conv_1",
      instanceName: "Test instance"
    });
    expect(platformReportSetup(config(false), "conv_1")).toBeUndefined();
    expect(platformReportSetup(config(undefined), "conv_1")).toBeUndefined();
    expect(platformReportSetup(config(true), undefined)).toBeUndefined();
  });

  it("is not offered in an embedding host's session, which the server refuses the report", () => {
    const config: Pick<SafeConfig, "clientInstance" | "platformReport"> = {
      clientInstance: { id: "client_test", displayName: "Test instance", environment: "test" },
      platformReport: { available: true }
    };
    expect(platformReportSetup(config, "conv_1", true)).toBeUndefined();
    expect(platformReportSetup(config, "conv_1", false)).toMatchObject({
      conversationId: "conv_1"
    });
  });

  it("takes a run's platform code and no other failure", () => {
    expect(
      platformFailureOfRunError({ class: "run_failed", code: AGENT_RUN_COMMAND_NOT_TAKEN_CODE })
    ).toEqual({ errorCode: AGENT_RUN_COMMAND_NOT_TAKEN_CODE });
    expect(
      platformFailureOfRunError({ class: "run_failed", code: "MODEL_FAILED" })
    ).toBeUndefined();
    expect(
      platformFailureOfRunError({ class: "stream", code: AGENT_RUN_COMMAND_NOT_TAKEN_CODE })
    ).toBeUndefined();
  });

  it("names the platform failure on the run's finished answer and on no other message", () => {
    const failures = (result: ToolExecutionResult) =>
      toUiMessages(messagesWith(result)).map((message) =>
        typeof message.metadata === "object" && message.metadata !== null
          ? Reflect.get(Reflect.get(message.metadata, "custom") ?? {}, "platformFailure")
          : undefined
      );
    expect(failures(platformFailure)).toEqual([
      undefined,
      { errorCode: "sandbox_unavailable", at: "2026-10-27T09:15:00.000Z" }
    ]);
    expect(failures(commandFailure)).toEqual([undefined, undefined]);
  });

  it("is not offered under a command's own failure, nor without a support address", async () => {
    await render(messagesWith(commandFailure));
    expect(host.querySelector('[data-role="assistant"]')).not.toBeNull();
    expect(action()).toBeNull();
    await render(messagesWith(platformFailure), false);
    expect(action()).toBeNull();
  });

  it("says what is sent and sends the note and nothing of the conversation", async () => {
    await render(messagesWith(platformFailure));
    expect(action()?.textContent).toContain("Report problem to Workshape");
    await act(async () => action()?.click());
    const dialog = document.querySelector('[data-testid="platform-report-dialog"]');
    expect(dialog?.textContent).toContain("run_1");
    expect(dialog?.textContent).toContain("sandbox_unavailable");
    expect(dialog?.textContent).toContain("Test instance");
    // Without an address on the account there is nothing to reply to.
    expect(dialog?.querySelector('[role="checkbox"]')).toBeNull();

    const textarea = dialog?.querySelector("textarea");
    if (!textarea) throw new Error("No field");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setValue?.call(textarea, "  I was totalling invoices  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = document.querySelector<HTMLButtonElement>('[data-testid="platform-report-send"]');
    await act(async () => send?.click());
    await settle();

    expect(sent).toEqual([
      { path: reportPath, body: { note: "I was totalling invoices", replyToMe: false } }
    ]);
    expect(JSON.stringify(sent)).not.toContain(QUESTION);
    expect(JSON.stringify(sent)).not.toContain(ANSWER);
    expect(document.querySelector('[data-testid="platform-report-dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="platform-report-sent"]')?.textContent).toBe(
      "Reported to Workshape"
    );
    expect(action()).toBeNull();
  });
});
