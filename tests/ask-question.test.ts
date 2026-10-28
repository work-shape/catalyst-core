import { createElement } from "react";
import type { PartState } from "@assistant-ui/react";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  ASK_QUESTION_TOOL_NAME,
  asClientInstanceId,
  readAssistantFinalMetadata,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import type { ModelCompletionRequest } from "@work-shape/catalyst-model-provider";
import { createAskQuestionTool, ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import {
  QuestionCardView,
  isQuestionCall,
  questionAnswers,
  readAskedQuestion
} from "@work-shape/catalyst-chat-ui/questions";
import { describe, expect, it } from "vitest";
import { createConversationWithMessages, noReportedUsage } from "./helpers/agent-runtime";
import { withTestModelGateway } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";
import {
  createAssistantMessageGroupBy,
  createVisibleFinalAssistantPartIndices
} from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// ASK-1: the agent asks the person one question with a few answers. The tool answers the
// question as the card shows it, the recommended answer first; the run ends its turn after the
// step that asked; the person's next message is the answer, also after a reload.

const tool = createAskQuestionTool();
const asked = {
  question: "Who should be able to use the overview?",
  options: [
    { label: "My whole team", description: "Everyone sees the same figures" },
    { label: "Only me", description: "You can share it later", recommended: true }
  ]
};

function toolContext(): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("ask-question-client");
  return {
    clientInstanceId,
    correlationId: "corr_ask_question",
    user: {
      id: "user-ask",
      externalUserId: "user-ask",
      displayLabel: "Ask User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

/** Runs the tool as the runtime does: the input through its schema. */
async function run(input: unknown) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" as const };
  return tool.execute(parsed.data, toolContext());
}

describe("the question tool", () => {
  it("answers the question with the recommended answer first", async () => {
    const result = await run(asked);
    expect(result).toMatchObject({
      status: "success",
      output: {
        question: asked.question,
        options: [
          { label: "Only me", description: "You can share it later", recommended: true },
          { label: "My whole team", description: "Everyone sees the same figures" }
        ]
      }
    });
  });

  it("takes two to four answers with their own labels and at most one recommended", async () => {
    const option = (label: string, recommended?: boolean) => ({
      label,
      ...(recommended ? { recommended } : {})
    });
    expect((await run({ question: "Q?", options: [option("A")] })).status).toBe("invalid");
    expect(
      (await run({ question: "Q?", options: ["A", "B", "C", "D", "E"].map((l) => option(l)) }))
        .status
    ).toBe("invalid");
    expect(
      (await run({ question: "Q?", options: [option("A", true), option("B", true)] })).status
    ).toBe("invalid");
    expect((await run({ question: "Q?", options: [option("A"), option("a")] })).status).toBe(
      "invalid"
    );
    expect((await run({ question: " ", options: [option("A"), option("B")] })).status).toBe(
      "invalid"
    );
  });

  it("tells the agent to ask about outcomes in everyday words, never about how it is built", () => {
    expect(tool.effect).toBe("reading");
    expect(tool.title?.de).toBe("Frage stellen");
    expect(tool.description).toContain("your turn ends after this step");
    expect(tool.description).toContain("Never ask about how it is built");
    expect(tool.description).toContain("storage, data stores, Workflows");
    expect(tool.description).toContain('"Only me"');
  });
});

describe("a run that asks", () => {
  it("ends its turn after the step that asked, and the next message goes on from the answer", async () => {
    const clientInstanceId = asClientInstanceId("ask-question-runtime");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "ask-question",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const provider: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const requests: ModelCompletionRequest[] = [];
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              name: "builder",
              displayName: "Builder",
              instructions: "Build with the person.",
              modelProviderId: provider.id,
              toolNames: [ASK_QUESTION_TOOL_NAME],
              skillNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [provider],
        defaultModelProvider: provider,
        conversationHistory: store.conversations,
        modelProvider: {
          id: provider.id,
          async complete(request: ModelCompletionRequest) {
            requests.push(request);
            return requests.length === 1
              ? {
                  text: "One thing first.",
                  toolCalls: [
                    { toolCallId: "ask_1", toolName: ASK_QUESTION_TOOL_NAME, input: asked }
                  ],
                  usage: noReportedUsage()
                }
              : { text: "Then only for you.", toolCalls: [], usage: noReportedUsage() };
          }
        },
        toolRegistry: new ToolRegistry({ tools: [tool] }),
        runTool: async (request) => {
          const parsed = tool.inputSchema.parse(request.input);
          return tool.execute(parsed, toolContext());
        },
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const drain = async (runId: Parameters<typeof runtime.observe>[0]) => {
      const types: string[] = [];
      for await (const event of runtime.observe(runId, context)) types.push(event.type);
      return types;
    };

    const first = await runtime.start(
      { agentName: "builder", conversationId, message: { text: "Build me an overview." } },
      context
    );
    const events = await drain(first.runId);
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toBe("run_completed");
    expect(
      requests[0]?.tools.some(
        (offered) => "name" in offered && offered.name === ASK_QUESTION_TOOL_NAME
      )
    ).toBe(true);
    const afterAsk = await store.conversations.listMessages({ clientInstanceId, conversationId });
    // The step and its result are kept; no final answer follows the question. (The person's
    // message is stored by the API that starts the run, not by the runtime.)
    expect(afterAsk.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(afterAsk.some((message) => readAssistantFinalMetadata(message.metadata))).toBe(false);

    const second = await runtime.start(
      { agentName: "builder", conversationId, message: { text: "Only me" } },
      context
    );
    await drain(second.runId);
    expect(requests).toHaveLength(2);
    // The model reads its question, the answer the card showed, and then the person's choice.
    const roles = requests[1]?.messages.map((message) => message.role) ?? [];
    expect(roles.slice(-3)).toEqual(["assistant", "tool", "user"]);
  });
});

describe("the question card", () => {
  const part = (toolCallId: string) => ({
    type: "tool-call",
    toolCallId,
    toolName: ASK_QUESTION_TOOL_NAME,
    args: asked,
    result: { question: asked.question, options: [asked.options[1], asked.options[0]] }
  });

  it("reads the question from the tool's answer, the recommended answer first", () => {
    expect(readAskedQuestion(part("q").result)).toEqual({
      question: asked.question,
      options: [
        { label: "Only me", description: "You can share it later", recommended: true },
        { label: "My whole team", description: "Everyone sees the same figures" }
      ]
    });
    expect(readAskedQuestion({ question: "Q?", options: [] })).toBeUndefined();
    expect(isQuestionCall({ ...part("q"), result: { message: "refused" } })).toBe(false);
  });

  it("is answered by the person's first message after it, whether picked or typed", () => {
    const text = (value: string) => ({ type: "text", text: value });
    const answers = questionAnswers([
      { role: "user", parts: [text("Build me an overview.")] },
      { role: "assistant", parts: [text("One thing first."), part("q1")] },
      { role: "user", parts: [text("Only me")] },
      { role: "assistant", parts: [text("Done."), part("q2")] },
      { role: "user", parts: [text("For the team, but read only")] },
      { role: "assistant", parts: [part("q3")] }
    ]);
    expect(answers.get("q1")).toBe("Only me");
    expect(answers.get("q2")).toBe("For the team, but read only");
    // No message follows the last question yet: it is open.
    expect(answers.has("q3")).toBe(false);
  });

  it("stands in the thread during and after the run, beside the answer's text", () => {
    const call: PartState = {
      ...part("q1"),
      type: "tool-call",
      args: { question: asked.question },
      argsText: "{}",
      status: { type: "complete" }
    };
    const parts: PartState[] = [
      { type: "text", text: "One thing first.", status: { type: "complete" } },
      call
    ];
    const groupBy = createAssistantMessageGroupBy();
    expect(groupBy(call, {})).toEqual([]);
    expect(createVisibleFinalAssistantPartIndices(parts, 0)).toEqual([0, 1]);
  });

  it("shows the answers in German with the recommended one marked, then the answer given", () => {
    const question = readAskedQuestion(part("q").result);
    if (!question) throw new Error("no question");
    const render = (node: ReturnType<typeof createElement>) =>
      renderToStaticMarkup(createElement(TranslationProvider, { locale: "de", children: node }));
    const open = render(
      createElement(QuestionCardView, { asked: question, onAnswer: () => undefined })
    );
    expect(open).toContain('data-state="open"');
    expect(open).toContain("Empfohlen");
    expect(open).toContain("Oder eigene Antwort");
    expect(open.indexOf("Only me")).toBeLessThan(open.indexOf("My whole team"));
    const answered = render(
      createElement(QuestionCardView, { asked: question, answer: "Only me" })
    );
    expect(answered).toContain('data-state="answered"');
    expect(answered).toContain("Deine Antwort");
    expect(answered).not.toContain("data-question-option");
    expect(answered).not.toContain("data-question-own");
  });
});
