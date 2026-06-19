import { describe, expect, it } from "vitest";
import type { Message } from "@vivd-catalyst/api-client";
import { toUiMessages } from "../packages/chat-ui/src/assistant-chat-panel";

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
                toolName: "show_view",
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
            toolName: "show_view",
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
});
