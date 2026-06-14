import { describe, expect, it } from "vitest";
import type { Message } from "@vivd-catalyst/api-client";
import { toUiMessages } from "../packages/chat-ui/src/assistant-chat-panel";

describe("chat UI message history projection", () => {
  it("replays persisted tool displays as completed dynamic tool parts", () => {
    const messages: Message[] = [
      {
        id: "msg_user",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "user",
        text: "show a dashboard",
        createdAt: "2026-06-15T00:00:00.000Z"
      },
      {
        id: "msg_tool_call",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "",
        createdAt: "2026-06-15T00:00:01.000Z",
        metadata: {
          agentRuntime: {
            version: 1,
            kind: "assistant_tool_calls",
            runId: "run_test",
            toolCalls: [
              {
                toolCallId: "call_render",
                toolName: "renderHtml",
                input: {
                  html: "<section>Dashboard</section>"
                }
              }
            ]
          }
        }
      },
      {
        id: "msg_tool_result",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "tool",
        text: "{\"displayed\":true}",
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: {
          agentRuntime: {
            version: 1,
            kind: "tool_result",
            runId: "run_test",
            toolCallId: "call_render",
            toolName: "renderHtml",
            input: {
              html: "<section>Dashboard</section>"
            },
            result: {
              status: "success",
              output: {
                displayed: true
              },
              display: {
                kind: "html.rendered",
                version: 1,
                mode: "inline",
                data: {
                  html: "<section>Dashboard</section>",
                  title: "Dashboard"
                }
              }
            },
            modelOutput: "{\"displayed\":true}"
          }
        }
      },
      {
        id: "msg_final",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "Here is the dashboard.",
        createdAt: "2026-06-15T00:00:03.000Z"
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected).toHaveLength(3);
    expect(projected[1]).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "renderHtml",
          toolCallId: "call_render",
          state: "output-available",
          output: {
            status: "success",
            display: {
              kind: "html.rendered",
              mode: "inline",
              data: {
                title: "Dashboard"
              }
            }
          }
        }
      ]
    });
  });
});
