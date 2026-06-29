import { describe, expect, it } from "vitest";
import type { Message } from "@vivd-catalyst/api-client";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@vivd-catalyst/core";
import { toUiMessages } from "../packages/chat-ui/src/assistant-ui-adapter";
import {
  readToolArtifactRefs,
  readToolDetailSections
} from "../packages/chat-ui/src/tool-call";

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

    expect(projected).toHaveLength(3);
    expect(projected[1]).toMatchObject({
      role: "assistant",
      parts: [
        {
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
        }
      ]
    });
  });

  it("replays promoted workspace artifact refs while suppressing internal workspace details", () => {
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
              toolName: "workspace.exec",
              input: {
                command: "cat scratch/final-report.pdf && echo shell"
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
        text: "{\"status\":\"completed\"}",
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_test",
          toolCall: {
            toolCallId: "call_workspace",
            toolName: "workspace.exec",
            input: {
              command: "cat scratch/final-report.pdf && echo shell"
            }
          },
          result: {
            status: "success",
            output: {
              commandId: "wcmd_test",
              workspaceId: "ews_test",
              status: "completed",
              stdoutPreview: "shell stdout preview",
              stderrPreview: "shell stderr preview",
              changedFiles: [
                {
                  path: "scratch/final-report.pdf",
                  byteSize: 128,
                  checksum: "sha256:final",
                  mimeType: "application/pdf",
                  artifactId: "art_final"
                }
              ],
              promotedArtifacts: [
                {
                  artifactId: "art_final",
                  path: "scratch/final-report.pdf",
                  kind: "application/pdf",
                  mimeType: "application/pdf"
                }
              ]
            },
            artifacts: [
              {
                artifactId: "art_final",
                kind: "application/pdf",
                filename: "final-report.pdf",
                mimeType: "application/pdf",
                metadata: {
                  source: "execution_workspace",
                  workspacePath: "scratch/final-report.pdf"
                }
              }
            ]
          },
          modelOutput: {
            text: "{\"status\":\"completed\"}"
          }
        })
      }
    ];

    const projected = toUiMessages(messages);
    const toolPart = projected[0]?.parts[0] as
      | { type: string; output?: unknown }
      | undefined;

    expect(toolPart).toMatchObject({
      type: "dynamic-tool",
      output: {
        status: "success",
        artifacts: [
          {
            artifactId: "art_final",
            filename: "final-report.pdf"
          }
        ]
      }
    });
    expect(readToolArtifactRefs(toolPart?.output)).toEqual([
      {
        artifactId: "art_final",
        kind: "application/pdf",
        filename: "final-report.pdf",
        mimeType: "application/pdf"
      }
    ]);
    const detailSections = readToolDetailSections({
      args: {
        command: "cat scratch/final-report.pdf && echo shell"
      },
      labels: { input: "Input", output: "Output" },
      result: toolPart?.output,
      toolName: "workspace.exec"
    });
    expect(detailSections).toEqual([]);
    expect(JSON.stringify(detailSections)).not.toContain("scratch/final-report.pdf");
    expect(JSON.stringify(detailSections)).not.toContain("shell stdout preview");
    expect(JSON.stringify(detailSections)).not.toContain("shell stderr preview");
    expect(JSON.stringify(detailSections)).not.toContain("workspacePath");
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
});
