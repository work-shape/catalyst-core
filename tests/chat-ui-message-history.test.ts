import { describe, expect, it } from "vitest";
import { fromThreadMessageLike } from "@assistant-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRunProjection, Message } from "@vivd-catalyst/api-client";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@vivd-catalyst/core";
import { toUiMessages } from "../packages/chat-ui/src/assistant/assistant-ui-adapter";
import { AssistantSourcePart } from "../packages/chat-ui/src/assistant/assistant-source-part";

describe("chat UI message history projection", () => {
  it("replays persisted user document manifests as file attachments", () => {
    const messages: Message[] = [
      {
        id: "msg_user",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "user",
        text: "summarize this",
        createdAt: "2026-06-15T00:00:00.000Z",
        metadata: {
          agentRuntime: {
            version: 1,
            kind: "user_message",
            attachmentManifest: {
              version: 1,
              attachments: [
                {
                  fileId: "file_boardingpass",
                  attachmentId: "att_boardingpass",
                  filename: "Felix - Boardingpass.pdf",
                  mimeType: "application/pdf",
                  byteSize: 157593,
                  status: "ready",
                  readable: true,
                  modelContext: {
                    section: "Attached documents",
                    text: '- Felix - Boardingpass.pdf (fileId: file_boardingpass, status: ready, size: 157593 bytes, format: pdf, words: 420, pages: 2). Use read_document({ "fileId": "file_boardingpass", "mode": "full" }) to read the full prepared text.'
                  },
                  metadata: {
                    fileId: "file_boardingpass",
                    filename: "Felix - Boardingpass.pdf",
                    mimeType: "application/pdf",
                    byteSize: 157593,
                    format: "pdf",
                    wordCount: 420,
                    pageCount: 2,
                    warnings: [],
                    preprocessingVersion: "document-preprocessing-v1"
                  }
                }
              ]
            }
          }
        }
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[0]).toMatchObject({
      role: "user",
      parts: [
        {
          type: "text",
          text: "summarize this",
          state: "done"
        },
        {
          type: "file",
          mediaType: "application/pdf",
          filename: "Felix - Boardingpass.pdf",
          url: "vivd-file://file_boardingpass"
        }
      ]
    });
  });

  it("replays persisted user image manifests as image file parts", () => {
    const messages: Message[] = [
      {
        id: "msg_user",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "user",
        text: "what is in this image?",
        createdAt: "2026-06-15T00:00:00.000Z",
        metadata: {
          agentRuntime: {
            version: 1,
            kind: "user_message",
            attachmentManifest: {
              version: 1,
              attachments: [
                {
                  kind: "image",
                  fileId: "file_receipt",
                  attachmentId: "att_receipt",
                  filename: "receipt.png",
                  mimeType: "image/png",
                  byteSize: 8,
                  status: "ready",
                  readable: false,
                  modelVisibility: {
                    type: "image",
                    mimeType: "image/png"
                  },
                  modelContext: {
                    section: "Attached images",
                    text: "- receipt.png (fileId: file_receipt, status: ready, mimeType: image/png, size: 8 bytes). The image is loaded directly into visual context when the provider supports image inputs."
                  },
                  metadata: {
                    fileId: "file_receipt",
                    filename: "receipt.png",
                    mimeType: "image/png",
                    byteSize: 8,
                    format: "png",
                    checksum: "checksum"
                  }
                }
              ]
            }
          }
        }
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[0]).toMatchObject({
      role: "user",
      parts: [
        {
          type: "text",
          text: "what is in this image?",
          state: "done"
        },
        {
          type: "file",
          mediaType: "image/png",
          filename: "receipt.png",
          url: "vivd-file://file_receipt"
        }
      ]
    });
  });

  it("ignores malformed compatibility attachment manifest entries", () => {
    const messages: Message[] = [
      {
        id: "msg_user",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "user",
        text: "summarize this",
        createdAt: "2026-06-15T00:00:00.000Z",
        metadata: {
          agentRuntime: {
            version: 1,
            kind: "user_message",
            attachmentManifest: {
              version: 1,
              attachments: [
                {
                  fileId: 42,
                  filename: "bad.pdf"
                },
                {
                  fileId: "file_without_name"
                }
              ]
            }
          }
        }
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[0]?.parts).toEqual([
      {
        type: "text",
        text: "summarize this",
        state: "done"
      }
    ]);
  });

  it("projects persisted assistant web sources as assistant-ui source parts", () => {
    const messages: Message[] = [
      {
        id: "msg_web_answer",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "The current result is cited.",
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_web",
          sources: [
            {
              id: "web_source_1",
              url: "https://example.com/report",
              title: "Example Report",
              provider: "openai-native",
              query: "example report",
              snippet: "A short source snippet.",
              resultPosition: 1
            }
          ],
          citations: [
            {
              sourceId: "web_source_1",
              label: "Example Report",
              characterRange: {
                start: 4,
                end: 18
              }
            }
          ]
        })
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[0]?.parts).toEqual([
      {
        type: "text",
        text: "The current result is cited.",
        state: "done"
      },
      {
        type: "dynamic-tool",
        toolName: "web_search",
        toolCallId: "web_search:msg_web_answer",
        title: "web_search",
        state: "output-available",
        input: {
          query: "example report"
        },
        output: {
          sourceCount: 1,
          sources: [
            {
              url: "https://example.com/report",
              title: "Example Report",
              provider: "openai-native",
              query: "example report",
              snippet: "A short source snippet.",
              resultPosition: 1
            }
          ]
        }
      },
      {
        type: "source-url",
        sourceId: "web_source_1",
        url: "https://example.com/report",
        title: "Example Report",
        providerMetadata: {
          vivdCatalyst: {
            provider: "openai-native",
            query: "example report",
            snippet: "A short source snippet.",
            resultPosition: 1,
            citations: [
              {
                sourceId: "web_source_1",
                label: "Example Report",
                characterRange: {
                  start: 4,
                  end: 18
                }
              }
            ]
          }
        }
      }
    ]);
  });

  it("does not duplicate synthetic web search work when a completed run already has a web_search tool call", () => {
    const messages: Message[] = [
      {
        id: "msg_web_tool",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "",
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: createAssistantToolCallsMetadata({
          runId: "run_web",
          toolCalls: [
            {
              toolCallId: "call_web",
              toolName: "web_search",
              input: {
                query: "example report"
              }
            }
          ]
        })
      },
      {
        id: "msg_web_answer",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "The current result is cited.",
        createdAt: "2026-07-01T00:00:01.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_web",
          sources: [
            {
              id: "web_source_1",
              url: "https://example.com/report",
              title: "Example Report",
              provider: "openai-native",
              query: "example report"
            }
          ]
        })
      }
    ];

    const projected = toUiMessages(messages);
    const assistantParts = projected[0]?.parts ?? [];
    const webToolParts = assistantParts.filter(
      (part) => part.type === "dynamic-tool" && "toolName" in part && part.toolName === "web_search"
    );

    expect(projected).toHaveLength(1);
    expect(webToolParts).toHaveLength(1);
    expect(webToolParts[0]).toMatchObject({
      toolCallId: "call_web",
      toolName: "web_search"
    });
    expect(assistantParts).toContainEqual({
      type: "source-url",
      sourceId: "web_source_1",
      url: "https://example.com/report",
      title: "Example Report",
      providerMetadata: {
        vivdCatalyst: {
          provider: "openai-native",
          query: "example report",
          citations: []
        }
      }
    });
  });

  it("uses completed run projections to preserve work and final-answer chronology", () => {
    const progressText =
      "Ich prüfe kurz die aktuellen offiziellen Regeln, damit die Antwort rechtlich sauber ist.";
    const finalText = "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen.";
    const messages: Message[] = [
      {
        id: "msg_web_answer",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: `${progressText}${finalText}`,
        createdAt: "2026-07-01T00:00:01.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_web",
          sources: [
            {
              id: "web_source_1",
              url: "https://www.gesetze-im-internet.de/verpackg/__31.html",
              title: "VerpackG § 31",
              provider: "openai-native",
              query: "Pfand Annahmepflicht Supermarkt Deutschland"
            }
          ]
        })
      }
    ];
    const completedRunProjections: Record<string, AgentRunProjection> = {
      run_web: {
        runId: "run_web",
        lastSequence: 6,
        status: "completed",
        durationMs: 102_000,
        text: `${progressText}${finalText}`,
        reasoning: [],
        activeToolCalls: [
          {
            toolCallId: "call_web",
            toolName: "web_search",
            input: {
              query: "Pfand Annahmepflicht Supermarkt Deutschland"
            },
            state: "output_available",
            output: {
              status: "success",
              output: {
                query: "Pfand Annahmepflicht Supermarkt Deutschland"
              }
            }
          }
        ],
        parts: [
          {
            type: "text",
            text: progressText
          },
          {
            type: "tool_call",
            toolCallId: "call_web",
            toolName: "web_search",
            input: {
              query: "Pfand Annahmepflicht Supermarkt Deutschland"
            },
            state: "output_available",
            output: {
              status: "success",
              output: {
                query: "Pfand Annahmepflicht Supermarkt Deutschland"
              }
            }
          },
          {
            type: "text",
            text: finalText
          }
        ]
      }
    };

    const projected = toUiMessages(messages, undefined, completedRunProjections);
    const textParts = (projected[0]?.parts ?? []).filter((part) => part.type === "text");
    const webToolParts = (projected[0]?.parts ?? []).filter(
      (part) => part.type === "dynamic-tool" && "toolName" in part && part.toolName === "web_search"
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.metadata).toMatchObject({
      custom: {
        completedRunId: "run_web",
        runDurationMs: 102_000
      }
    });
    const metadata = projected[0]?.metadata;
    if (!isRecord(metadata) || !isRecord(metadata.custom)) {
      throw new Error("Expected completed-run custom metadata");
    }
    const normalizedMessage = fromThreadMessageLike(
      {
        role: "assistant",
        content: [],
        metadata: { custom: metadata.custom }
      },
      "msg_web_answer",
      { type: "complete", reason: "stop" }
    );
    expect(normalizedMessage.metadata.custom).toMatchObject({
      completedRunId: "run_web",
      runDurationMs: 102_000
    });
    expect(textParts).toEqual([
      {
        type: "text",
        text: progressText,
        state: "done"
      },
      {
        type: "text",
        text: finalText,
        state: "done"
      }
    ]);
    expect(webToolParts).toHaveLength(1);
    expect(webToolParts[0]).toMatchObject({
      toolCallId: "call_web",
      toolName: "web_search"
    });
    expect(projected[0]?.parts).toContainEqual(
      expect.objectContaining({
        type: "source-url",
        sourceId: "web_source_1"
      })
    );
  });

  it("falls back to persisted final text when a completed run projection is unavailable", () => {
    const answerText =
      "Die Antwort hängt vom Pfandsystem ab. Kurz: Nein, nicht jedes Pfand muss angenommen werden.";
    const messages: Message[] = [
      {
        id: "msg_web_answer",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: answerText,
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_web",
          sources: [
            {
              id: "web_source_1",
              url: "https://www.gesetze-im-internet.de/verpackg/__31.html",
              title: "VerpackG § 31",
              provider: "openai-native"
            }
          ]
        })
      }
    ];

    const projected = toUiMessages(messages);
    const textParts = (projected[0]?.parts ?? []).filter((part) => part.type === "text");

    expect(textParts).toEqual([
      {
        type: "text",
        text: answerText,
        state: "done"
      }
    ]);
  });

  it("preserves persisted final text when a completed run projection is incomplete", () => {
    const progressText = "Ich prüfe kurz die aktuellen offiziellen Regeln.";
    const finalText = "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen.";
    const messages: Message[] = [
      {
        id: "msg_web_answer",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: `${progressText}${finalText}`,
        createdAt: "2026-07-01T00:00:00.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_web"
        })
      }
    ];
    const incompleteProjection: AgentRunProjection = {
      runId: "run_web",
      status: "completed",
      lastSequence: 3,
      text: progressText,
      reasoning: [],
      activeToolCalls: [],
      parts: [
        {
          type: "text",
          text: progressText
        },
        {
          type: "tool_call",
          toolCallId: "call_web",
          toolName: "web_search",
          input: {
            query: "Pfand Annahmepflicht Supermarkt Deutschland"
          },
          state: "output_available",
          output: {
            status: "success"
          }
        }
      ]
    };

    const projected = toUiMessages(messages, undefined, {
      run_web: incompleteProjection
    });
    const parts = projected[0]?.parts ?? [];

    expect(parts.filter((part) => part.type === "text")).toEqual([
      {
        type: "text",
        text: progressText,
        state: "done"
      },
      {
        type: "text",
        text: finalText,
        state: "done"
      }
    ]);
    expect(parts.filter((part) => part.type === "dynamic-tool")).toHaveLength(1);
  });

  it("strips repeated progress text from legacy final run messages without completed projections", () => {
    const progressText =
      "Ich prüfe kurz die aktuellen offiziellen Regeln, damit die Antwort rechtlich sauber ist.";
    const finalText = "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen.";
    const messages: Message[] = [
      {
        id: "msg_progress",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: progressText,
        createdAt: "2026-07-01T00:00:01.000Z",
        metadata: createAssistantToolCallsMetadata({
          runId: "run_web",
          toolCalls: [
            {
              toolCallId: "call_web",
              toolName: "web_search",
              input: {
                query: "Pfand Annahmepflicht Supermarkt Deutschland"
              }
            }
          ]
        })
      },
      {
        id: "msg_tool_result",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "tool",
        text: '{"ok":true}',
        createdAt: "2026-07-01T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_web",
          toolCall: {
            toolCallId: "call_web",
            toolName: "web_search",
            input: {
              query: "Pfand Annahmepflicht Supermarkt Deutschland"
            }
          },
          result: {
            status: "success",
            output: {
              ok: true
            }
          },
          modelOutput: {
            text: JSON.stringify({ ok: true })
          }
        })
      },
      {
        id: "msg_final",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: `${progressText}${finalText}`,
        createdAt: "2026-07-01T00:00:03.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_web"
        })
      }
    ];

    const projected = toUiMessages(messages);
    const parts = projected[0]?.parts ?? [];
    const textParts = parts.filter((part) => part.type === "text");
    const toolParts = parts.filter((part) => part.type === "dynamic-tool");

    expect(projected).toHaveLength(1);
    expect(textParts).toEqual([
      {
        type: "text",
        text: progressText,
        state: "done"
      },
      {
        type: "text",
        text: finalText,
        state: "done"
      }
    ]);
    expect(toolParts).toHaveLength(1);
    expect(toolParts[0]).toMatchObject({
      toolCallId: "call_web",
      toolName: "web_search",
      state: "output-available"
    });
  });

  it("renders assistant web source parts", () => {
    const sourcePart = {
      type: "source",
      sourceType: "url",
      id: "web_source_1",
      url: "https://example.com/report",
      title: "Example Report",
      status: { type: "complete" }
    } as const;

    const indexedMarkup = renderToStaticMarkup(createElement(AssistantSourcePart, sourcePart));
    expect(indexedMarkup).toContain('href="https://example.com/report"');
    expect(indexedMarkup).toContain("Example Report");
  });

  it("falls back to text rendering for unknown message metadata", () => {
    const messages: Message[] = [
      {
        id: "msg_future",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "Future metadata should not hide this response.",
        createdAt: "2026-06-15T00:00:00.000Z",
        metadata: {
          agentRuntime: {
            version: 1,
            kind: "future_variant",
            runId: "run_future",
            payload: {
              unsupported: true
            }
          }
        }
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected).toEqual([
      expect.objectContaining({
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "Future metadata should not hide this response.",
            state: "done"
          }
        ]
      })
    ]);
  });

  it("projects an automatic compaction marker from assistant context metadata", () => {
    const projected = toUiMessages([
      {
        id: "msg_compacted",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "Continuing with the compacted context.",
        createdAt: "2026-07-30T10:00:00.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_compacted",
          modelContext: {
            inputTokens: 80_000,
            compactThresholdTokens: 270_000,
            compacted: true
          }
        })
      }
    ]);

    expect(projected[0]?.metadata).toMatchObject({
      custom: {
        completedRunId: "run_compacted",
        contextCompacted: true
      }
    });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
