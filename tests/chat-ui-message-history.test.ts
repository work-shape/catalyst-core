import { describe, expect, it } from "vitest";
import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { AgentRunProjection, Message } from "@vivd-catalyst/api-client";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@vivd-catalyst/core";
import { toUiMessages } from "../packages/chat-ui/src/assistant-ui-adapter";
import { AssistantSourcePart } from "../packages/chat-ui/src/assistant-source-part";
import { ToolDisplayPanelProvider } from "../packages/chat-ui/src/tool-display-panel";
import { ToolSurfaceList } from "../packages/chat-ui/src/tool-surface-card";
import { dedupeToolSurfaceRefs } from "../packages/chat-ui/src/tool-surfaces";
import {
  readToolActionLabel,
  readToolDetailSections,
  readToolDisplayProjection
} from "../packages/chat-ui/src/tool-call";
import { readToolArtifactRefs } from "../packages/chat-ui/src/tool-artifacts";

describe("chat UI message history projection", () => {
  it("defers promoted result cards until the active run finishes", () => {
    const projected = toUiMessages([], {
      run: {
        id: "run_active",
        status: "running"
      },
      projection: {
        runId: "run_active",
        lastSequence: 3,
        status: "running",
        text: "",
        reasoning: [],
        activeToolCalls: [],
        parts: [
          {
            type: "tool_call",
            toolCallId: "call_review",
            toolName: "submit_review",
            input: {},
            state: "output_available",
            output: {
              status: "success",
              display: {
                kind: "review.result",
                version: 1,
                mode: "side_panel",
                title: "Review",
                data: {}
              }
            }
          }
        ]
      }
    });

    expect(projected[0]?.parts).not.toContainEqual(
      expect.objectContaining({ type: "data-workspace-promoted-surfaces" })
    );
  });

  it("surfaces side-panel displays while a completed run is still active", () => {
    const projected = toUiMessages([], {
      run: {
        id: "run_active",
        status: "completed"
      },
      projection: {
        runId: "run_active",
        lastSequence: 4,
        status: "completed",
        text: "The review is ready.",
        reasoning: [],
        activeToolCalls: [],
        parts: [
          {
            type: "tool_call",
            toolCallId: "call_review",
            toolName: "submit_review",
            input: {},
            state: "output_available",
            output: {
              status: "success",
              display: {
                kind: "review.result",
                version: 1,
                mode: "side_panel",
                title: "Review",
                data: {}
              }
            }
          },
          {
            type: "text",
            text: "The review is ready."
          }
        ]
      }
    });

    expect(projected[0]?.metadata).toEqual({
      source: "active-run",
      activeRunCompleted: true
    });
    expect(projected[0]?.parts).toContainEqual({
      type: "data-workspace-promoted-surfaces",
      data: {
        kind: "workspace.promoted_surfaces",
        surfaces: [
          {
            surfaceId: "tool:call_review",
            toolCallId: "call_review",
            toolName: "submit_review",
            title: "Review",
            display: {
              kind: "review.result",
              version: 1,
              mode: "side_panel",
              title: "Review",
              data: {}
            }
          }
        ]
      }
    });
  });

  it("keeps the latest revision for repeated promoted surface ids", () => {
    expect(
      dedupeToolSurfaceRefs([
        {
          surfaceId: "structured-data:resource_1",
          title: "Customer data",
          display: {
            kind: "structured_data.resource",
            version: 1,
            data: {
              structuredDataResourceId: "resource_1",
              revision: 1
            }
          }
        },
        {
          surfaceId: "structured-data:resource_1",
          title: "Updated customer data",
          display: {
            kind: "structured_data.resource",
            version: 1,
            data: {
              structuredDataResourceId: "resource_1",
              revision: 2
            }
          }
        }
      ])
    ).toEqual([
      expect.objectContaining({
        title: "Updated customer data",
        display: expect.objectContaining({
          data: expect.objectContaining({ revision: 2 })
        })
      })
    ]);
  });

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
        metadata: createAssistantToolCallsMetadata({
          runId: "run_test",
          toolCalls: [
            {
              toolCallId: "call_render",
              toolName: "show_view",
              input: {
                html: "<section>Dashboard</section>"
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
        text: "{\"displayed\":true}",
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_test",
          toolCall: {
            toolCallId: "call_render",
            toolName: "show_view",
            input: {
              html: "<section>Dashboard</section>"
            }
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
          modelOutput: {
            text: "{\"displayed\":true}"
          }
        })
      },
      {
        id: "msg_final",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "Here is the dashboard.",
        createdAt: "2026-06-15T00:00:03.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_test"
        })
      }
    ];

    const projected = toUiMessages(messages);
    const assistantParts = projected[1]?.parts ?? [];

    expect(projected).toHaveLength(2);
    expect(projected[1]?.role).toBe("assistant");
    expect(projected[1]?.metadata).toEqual({ completedRunId: "run_test" });
    expect(assistantParts[0]).toMatchObject({
      type: "dynamic-tool",
      toolName: "show_view",
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
    });
    expect(assistantParts).toContainEqual({
      type: "text",
      text: "Here is the dashboard.",
      state: "done"
    });
    expect(assistantParts).toContainEqual({
      type: "data-workspace-promoted-surfaces",
      data: {
        kind: "workspace.promoted_surfaces",
        surfaces: [
          {
            surfaceId: "tool:call_render",
            toolCallId: "call_render",
            toolName: "show_view",
            title: "Dashboard",
            display: {
              kind: "html.rendered",
              version: 1,
              mode: "inline",
              data: {
                html: "<section>Dashboard</section>",
                title: "Dashboard"
              }
            }
          }
        ]
      }
    });
  });

  it("does not render inert final surface cards for unsupported display payloads", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolSurfaceList, {
          surfaces: [
            {
              surfaceId: "surface_unsupported",
              title: "Unsupported Dashboard",
              toolName: "show_view",
              display: {
                kind: "custom.unsupported",
                version: 1,
                mode: "side_panel",
                data: {
                  title: "Unsupported Dashboard"
                }
              }
            }
          ]
        })
      )
    );

    expect(markup).not.toContain("Unsupported Dashboard");
    expect(markup).not.toContain("button");
  });

  it("renders final surface cards as whole-card side panel openers", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolSurfaceList, {
          surfaces: [
            {
              surfaceId: "surface_dashboard",
              title: "Dashboard",
              toolName: "show_view",
              display: {
                kind: "html.rendered",
                version: 1,
                mode: "side_panel",
                data: {
                  html: "<section>Dashboard</section>",
                  title: "Dashboard"
                }
              }
            }
          ]
        })
      )
    );

    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="Open in side panel"');
    expect(markup).toContain("Dashboard");
  });

  it("renders structured data references as matching side-panel cards", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolSurfaceList, {
          surfaces: [
            {
              surfaceId: "structured-data:resource_1",
              title: "Customer data",
              toolName: "structured_data.publish",
              display: {
                kind: "structured_data.resource",
                version: 1,
                mode: "side_panel",
                data: {
                  structuredDataResourceId: "resource_1",
                  resourceKey: "customer_data",
                  revision: 1
                }
              }
            }
          ]
        })
      )
    );

    expect(markup).toContain('role="button"');
    expect(markup).toContain("Customer data");
    expect(markup).not.toContain("structured_data.publish");
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
    const progressText = "Ich prüfe kurz die aktuellen offiziellen Regeln, damit die Antwort rechtlich sauber ist.";
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
    expect(projected[0]?.parts).toContainEqual(expect.objectContaining({
      type: "source-url",
      sourceId: "web_source_1"
    }));
  });

  it("falls back to persisted final text when a completed run projection is unavailable", () => {
    const answerText = "Die Antwort hängt vom Pfandsystem ab. Kurz: Nein, nicht jedes Pfand muss angenommen werden.";
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
    const progressText = "Ich prüfe kurz die aktuellen offiziellen Regeln, damit die Antwort rechtlich sauber ist.";
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
        text: "{\"ok\":true}",
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
            status: "success",
            output: {
              ok: true
            }
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

  it("projects safe workspace exec helper details without raw command output", () => {
    const toolPart = projectPersistedToolPart({
      toolName: "workspace.exec",
      input: {
        command:
          "pptx_inspect --view summary scratch/musterbau-status.pptx && cat scratch/private-output.json"
      },
      result: {
        status: "success",
        output: {
          commandId: "wcmd_private",
          workspaceId: "ews_private",
          status: "completed",
          exitCode: 0,
          stdoutPreview: "{\"slides\":[{\"secret\":\"raw stdout json should stay hidden\"}]}",
          stderrPreview: "raw stderr preview should stay hidden",
          durationMs: 1234,
          changedFiles: [
            {
              path: "scratch/summary.json",
              objectKey: "execution-workspaces/private/summary.json",
              byteSize: 4096,
              checksum: "sha256:summary",
              mimeType: "application/json"
            }
          ],
          promotedArtifacts: [],
          truncated: {
            stdout: true,
            stderr: false
          }
        }
      }
    });

    expect(readToolActionLabel({
      args: toolPart.input,
      result: toolPart.output,
      toolName: "workspace.exec"
    })).toBe("pptx_inspect --view summary [redacted path] && cat [redacted path]");
    const detailSections = readToolDetailSections({
      args: toolPart.input,
      labels: { input: "Input", output: "Output" },
      result: toolPart.output,
      toolName: "workspace.exec"
    });
    const serializedDetails = JSON.stringify(detailSections);

    expect(serializedDetails).toContain("pptx_inspect --view summary");
    expect(serializedDetails).toContain("status completed");
    expect(serializedDetails).toContain("exit 0");
    expect(serializedDetails).toContain("1.2 s");
    expect(serializedDetails).toContain("stdout preview");
    expect(serializedDetails).toContain("(truncated)");
    expect(serializedDetails).toContain("summary.json");
    expect(serializedDetails).not.toContain("scratch/");
    expect(serializedDetails).not.toContain("execution-workspaces/private");
    expect(serializedDetails).not.toContain("objectKey");
    expect(serializedDetails).not.toContain("raw stdout json");
    expect(serializedDetails).not.toContain("raw stderr preview");
    expect(serializedDetails).not.toContain("wcmd_private");
    expect(serializedDetails).not.toContain("ews_private");
  });

  it("projects safe import, read, and promote workspace details", () => {
    const imported = projectPersistedToolPart({
      toolName: "workspace.import_files",
      input: {
        files: [{ fileId: "file_private_csv", path: "scratch/uploads/source.csv" }]
      },
      result: {
        status: "success",
        output: {
          workspaceId: "ews_private",
          importedFiles: [
            {
              fileId: "file_private_csv",
              path: "scratch/uploads/source.csv",
              filename: "source.csv",
              byteSize: 18,
              checksum: "sha256:source",
              mimeType: "text/csv",
              objectKey: "managed-files/private/source.csv"
            }
          ]
        }
      }
    });
    const read = projectPersistedToolPart({
      toolName: "workspace.read_file",
      input: {
        path: "scratch/large-result.json"
      },
      result: {
        status: "success",
        output: {
          workspaceId: "ews_private",
          path: "scratch/large-result.json",
          byteSize: 20000,
          mimeType: "application/json",
          encoding: "utf-8",
          contentPreview: JSON.stringify({
            raw: "x".repeat(20000),
            objectKey: "execution-workspaces/private/large-result.json"
          }),
          truncated: true
        }
      }
    });
    const promoted = projectPersistedToolPart({
      toolName: "workspace.promote_artifact",
      input: {
        path: "scratch/final-report.pdf",
        kind: "document.pdf",
        filename: "final-report.pdf",
        mimeType: "application/pdf"
      },
      result: {
        status: "success",
        output: {
          artifactId: "art_final",
          path: "scratch/final-report.pdf",
          kind: "document.pdf",
          filename: "final-report.pdf",
          mimeType: "application/pdf",
          byteSize: 1024,
          checksum: "sha256:final"
        },
        artifacts: [
          {
            artifactId: "art_final",
            kind: "document.pdf",
            filename: "final-report.pdf",
            mimeType: "application/pdf",
            metadata: {
              source: "execution_workspace",
              workspacePath: "scratch/final-report.pdf",
              objectKey: "execution-workspaces/private/final-report.pdf"
            }
          }
        ]
      }
    });

    expect(readToolActionLabel({
      args: imported.input,
      result: imported.output,
      toolName: "workspace.import_files"
    })).toBe("Imported 1 file");
    expect(readToolActionLabel({
      args: read.input,
      result: read.output,
      toolName: "workspace.read_file"
    })).toBe("Read large-result.json");
    expect(readToolActionLabel({
      args: promoted.input,
      result: promoted.output,
      toolName: "workspace.promote_artifact"
    })).toBe("Promoted final-report.pdf");
    expect(readToolArtifactRefs(promoted.output)).toEqual([
      {
        artifactId: "art_final",
        kind: "document.pdf",
        filename: "final-report.pdf",
        mimeType: "application/pdf"
      }
    ]);

    const serializedDetails = JSON.stringify([
      readToolDetailSections({
        args: imported.input,
        labels: { input: "Input", output: "Output" },
        result: imported.output,
        toolName: "workspace.import_files"
      }),
      readToolDetailSections({
        args: read.input,
        labels: { input: "Input", output: "Output" },
        result: read.output,
        toolName: "workspace.read_file"
      }),
      readToolDetailSections({
        args: promoted.input,
        labels: { input: "Input", output: "Output" },
        result: promoted.output,
        toolName: "workspace.promote_artifact"
      })
    ]);

    expect(serializedDetails).toContain("source.csv");
    expect(serializedDetails).toContain("18 B");
    expect(serializedDetails).toContain("large-result.json");
    expect(serializedDetails).toContain("file 20 KB");
    expect(serializedDetails).toContain("preview 20 KB (truncated)");
    expect(serializedDetails).toContain("final-report.pdf");
    expect(serializedDetails).toContain("document.pdf");
    expect(serializedDetails).not.toContain("file_private_csv");
    expect(serializedDetails).not.toContain("ews_private");
    expect(serializedDetails).not.toContain("scratch/");
    expect(serializedDetails).not.toContain("workspacePath");
    expect(serializedDetails).not.toContain("objectKey");
    expect(serializedDetails).not.toContain("execution-workspaces/private");
    expect(serializedDetails).not.toContain("xxxxx");
  });

  it("projects workspace failure reason codes without raw error details", () => {
    const toolPart = projectPersistedToolPart({
      toolName: "workspace.exec",
      input: {
        command: "xlsx_inspect --range Sheet1!A1:C10 scratch/workbook.xlsx"
      },
      result: {
        status: "failed",
        error: {
          code: "handler_failed",
          message:
            "Command failed while reading /Users/felixpahlke/code/vivd-catalyst/.worktrees/platform/scratch/workbook.xlsx"
        }
      }
    });

    const detailSections = readToolDetailSections({
      args: toolPart.input,
      labels: { input: "Input", output: "Output" },
      result: toolPart.output,
      toolName: "workspace.exec"
    });
    const serializedDetails = JSON.stringify(detailSections);

    expect(toolPart).toMatchObject({
      state: "output-error",
      output: {
        status: "failed",
        error: {
          code: "handler_failed"
        }
      }
    });
    expect(readToolActionLabel({
      args: toolPart.input,
      result: toolPart.output,
      toolName: "workspace.exec"
    })).toBe("xlsx_inspect --range Sheet1!A1:C10 [redacted path]");
    expect(serializedDetails).toContain("reason handler_failed");
    expect(serializedDetails).toContain("Command failed while reading");
    expect(serializedDetails).not.toContain("/Users/felixpahlke");
    expect(serializedDetails).not.toContain("scratch/workbook.xlsx");

    const timeoutDetails = JSON.stringify(readToolDetailSections({
      args: {
        command: "pptx_inspect --view summary scratch/deck.pptx"
      },
      labels: { input: "Input", output: "Output" },
      result: {
        status: "success",
        output: {
          status: "failed",
          exitCode: 124,
          stdoutPreview: "",
          stderrPreview: "",
          durationMs: 60000,
          changedFiles: [],
          promotedArtifacts: [],
          truncated: {
            stdout: false,
            stderr: false
          }
        }
      },
      toolName: "workspace.exec"
    }));
    const cancelledDetails = JSON.stringify(readToolDetailSections({
      args: {
        command: "pptx_inspect --view summary scratch/deck.pptx"
      },
      labels: { input: "Input", output: "Output" },
      result: {
        status: "success",
        output: {
          status: "cancelled",
          exitCode: null,
          stdoutPreview: "",
          stderrPreview: "",
          durationMs: 50,
          changedFiles: [],
          promotedArtifacts: [],
          truncated: {
            stdout: false,
            stderr: false
          }
        }
      },
      toolName: "workspace.exec"
    }));

    expect(timeoutDetails).toContain("reason timeout");
    expect(cancelledDetails).toContain("reason cancelled");
  });

  it("projects failed workspace exec command results as tool errors with sanitized output previews", () => {
    const toolPart = projectPersistedToolPart({
      toolName: "workspace.exec",
      input: {
        command: "docx_render scratch/final.docx --out scratch/previews"
      },
      result: {
        status: "success",
        output: {
          commandId: "wcmd_private",
          workspaceId: "ews_private",
          status: "failed",
          exitCode: 1,
          stdoutPreview: JSON.stringify({
            status: "failed",
            message: "Document render failed",
            objectKey: "execution-workspaces/private/final.docx",
            workspacePath: "scratch/final.docx",
            apiToken: "secret-token-value",
            details: {
              path: "/Users/felixpahlke/code/vivd-catalyst/.worktrees/private/scratch/final.docx",
              rawXml: "<w:document><w:t>secret document text</w:t></w:document>",
              xml: "<root>secret xml</root>",
              html: "<p>secret html</p>",
              content: "short sensitive body",
              body: "short body secret",
              base64: "c2hvcnQtc2VjcmV0",
              data: ["secret array item"],
              document: {
                text: "secret nested document text"
              }
            }
          }),
          stderrPreview: "Traceback in scratch/previews/page-1.png with Bearer abc.def.ghi",
          durationMs: 2345,
          changedFiles: [],
          promotedArtifacts: [],
          truncated: {
            stdout: true,
            stderr: false
          }
        }
      }
    });

    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      state: "output-error",
      errorText: "Workspace command failed"
    });

    const detailSections = readToolDetailSections({
      args: toolPart.input,
      labels: { input: "Input", output: "Output" },
      result: toolPart.output,
      toolName: "workspace.exec"
    });
    const serializedDetails = JSON.stringify(detailSections);

    expect(serializedDetails).toContain("status failed");
    expect(serializedDetails).toContain("exit 1");
    expect(serializedDetails).toContain("Document render failed");
    expect(serializedDetails).toContain("Stdout preview");
    expect(serializedDetails).toContain("Stderr preview");
    expect(serializedDetails).toContain("[truncated by runner]");
    expect(serializedDetails).toContain("[omitted broad content]");
    expect(serializedDetails).not.toContain("secret-token-value");
    expect(serializedDetails).not.toContain("abc.def.ghi");
    expect(serializedDetails).not.toContain("secret document text");
    expect(serializedDetails).not.toContain("secret xml");
    expect(serializedDetails).not.toContain("secret html");
    expect(serializedDetails).not.toContain("short sensitive body");
    expect(serializedDetails).not.toContain("short body secret");
    expect(serializedDetails).not.toContain("c2hvcnQtc2VjcmV0");
    expect(serializedDetails).not.toContain("secret array item");
    expect(serializedDetails).not.toContain("secret nested document text");
    expect(serializedDetails).not.toContain("objectKey");
    expect(serializedDetails).not.toContain("workspacePath");
    expect(serializedDetails).not.toContain("execution-workspaces/private");
    expect(serializedDetails).not.toContain("scratch/final.docx");
    expect(serializedDetails).not.toContain("scratch/previews");
    expect(serializedDetails).not.toContain("/Users/felixpahlke");
    expect(serializedDetails).not.toContain("xxxxx");
    expect(serializedDetails).not.toContain("wcmd_private");
    expect(serializedDetails).not.toContain("ews_private");
  });

  it("omits non-JSON XML-like failed workspace exec previews", () => {
    const detailSections = readToolDetailSections({
      args: {
        command: "docx_render final.docx --out previews"
      },
      labels: { input: "Input", output: "Output" },
      result: {
        status: "success",
        output: {
          status: "failed",
          exitCode: 1,
          stdoutPreview: "<w:document><w:t>secret document text</w:t></w:document>",
          stderrPreview: "<p>secret html</p>",
          durationMs: 20,
          changedFiles: [],
          promotedArtifacts: [],
          truncated: {
            stdout: false,
            stderr: false
          }
        }
      },
      toolName: "workspace.exec"
    });
    const serializedDetails = JSON.stringify(detailSections);

    expect(serializedDetails).toContain("[omitted structured markup]");
    expect(serializedDetails).not.toContain("secret document text");
    expect(serializedDetails).not.toContain("secret html");
    expect(serializedDetails).not.toContain("<w:document>");
    expect(serializedDetails).not.toContain("<p>");
  });

  it("keeps non-workspace tool details available", () => {
    const detailSections = readToolDetailSections({
      args: { text: "hello" },
      labels: { input: "Input", output: "Output" },
      result: { status: "success", output: "hello back" },
      toolName: "demo.echo"
    });

    expect(detailSections).toEqual([
      { label: "Input", value: JSON.stringify({ text: "hello" }, null, 2) },
      { label: "Output", value: JSON.stringify({ status: "success", output: "hello back" }, null, 2) }
    ]);
  });

  it("projects user-facing tool titles and call subjects", () => {
    expect(readToolDisplayProjection({
      args: { name: "pdf" },
      locale: "en",
      result: {
        status: "success",
        output: {
          name: "pdf",
          title: "PDF",
          description: "Render and inspect PDF artifacts.",
          content: "# PDF",
          sourceVersion: "sha256:test"
        }
      },
      toolName: "read_skill"
    })).toEqual({
      actionLabel: "PDF",
      technicalName: "read_skill",
      title: "Read instructions"
    });

    expect(readToolDisplayProjection({
      args: { name: "pdf" },
      locale: "de",
      result: undefined,
      toolName: "read_skill"
    })).toMatchObject({
      actionLabel: "PDF",
      technicalName: "read_skill",
      title: "Anleitung lesen"
    });

    expect(readToolDisplayProjection({
      args: {},
      locale: "en",
      result: undefined,
      toolName: "demo.workflow_summary"
    })).toEqual({
      actionLabel: undefined,
      technicalName: "demo.workflow_summary",
      title: "Workflow Summary"
    });
  });

  it("replays persisted tool failures as dynamic tool errors", () => {
    const messages: Message[] = [
      {
        id: "msg_tool_call",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "",
        createdAt: "2026-06-15T00:00:01.000Z",
        metadata: createAssistantToolCallsMetadata({
          runId: "run_test",
          toolCalls: [
            {
              toolCallId: "call_failed",
              toolName: "fetch_record",
              input: {
                id: "record_1"
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
        text: "Tool failed",
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_test",
          toolCall: {
            toolCallId: "call_failed",
            toolName: "fetch_record",
            input: {
              id: "record_1"
            }
          },
          result: {
            status: "failed",
            error: {
              code: "handler_failed",
              message: "Record service failed"
            }
          },
          modelOutput: {
            text: "Tool failed"
          }
        })
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[0]).toMatchObject({
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "fetch_record",
          toolCallId: "call_failed",
          state: "output-error",
          errorText: "Record service failed"
        }
      ]
    });
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
      completedRunId: "run_compacted",
      contextCompacted: true
    });
  });
});

function projectPersistedToolPart(input: {
  toolName: string;
  input: unknown;
  result: Parameters<typeof createToolResultMetadata>[0]["result"];
}): {
  type: string;
  state?: string;
  errorText?: string;
  input?: unknown;
  output?: unknown;
} {
  const messages: Message[] = [
    {
      id: "msg_tool_call",
      conversationId: "conv_test",
      clientInstanceId: "client_test",
      role: "assistant",
      text: "",
      createdAt: "2026-06-15T00:00:01.000Z",
      metadata: createAssistantToolCallsMetadata({
        runId: "run_test",
        toolCalls: [
          {
            toolCallId: "call_workspace",
            toolName: input.toolName,
            input: input.input
          }
        ]
      })
    },
    {
      id: "msg_tool_result",
      conversationId: "conv_test",
      clientInstanceId: "client_test",
      role: "tool",
      text: JSON.stringify(input.result),
      createdAt: "2026-06-15T00:00:02.000Z",
      metadata: createToolResultMetadata({
        runId: "run_test",
        toolCall: {
          toolCallId: "call_workspace",
          toolName: input.toolName,
          input: input.input
        },
        result: input.result,
        modelOutput: {
          text: JSON.stringify(input.result)
        }
      })
    }
  ];
  const projected = toUiMessages(messages);
  return projected[0]?.parts[0] as {
    type: string;
    state?: string;
    errorText?: string;
    input?: unknown;
    output?: unknown;
  };
}
