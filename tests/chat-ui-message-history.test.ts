import { describe, expect, it } from "vitest";
import type { Message } from "@vivd-catalyst/api-client";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@vivd-catalyst/core";
import { toUiMessages } from "../packages/chat-ui/src/assistant-ui-adapter";
import {
  readToolActionLabel,
  readToolDetailSections,
  readToolDisplayProjection
} from "../packages/chat-ui/src/tool-call";
import {
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs
} from "../packages/chat-ui/src/tool-artifacts";

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
    expect(readSurfacedToolArtifactRefs(toolPart?.output, "workspace.exec")).toEqual([
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
    expect(readToolActionLabel({
      args: {
        command: "cat scratch/final-report.pdf && echo shell"
      },
      result: toolPart?.output,
      toolName: "workspace.exec"
    })).toBe("cat");
    const serializedDetails = JSON.stringify(detailSections);
    expect(serializedDetails).toContain("status completed");
    expect(serializedDetails).toContain("final-report.pdf");
    expect(serializedDetails).not.toContain("scratch/final-report.pdf");
    expect(serializedDetails).not.toContain("shell stdout preview");
    expect(serializedDetails).not.toContain("shell stderr preview");
    expect(serializedDetails).not.toContain("workspacePath");
  });

  it("surfaces promoted workspace artifacts on the final assistant message", () => {
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
              toolCallId: "call_promote",
              toolName: "workspace.promote_artifact",
              input: {
                path: "scratch/ducks.pptx",
                filename: "ducks.pptx"
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
        text: "{\"artifactId\":\"art_ducks\"}",
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_test",
          toolCall: {
            toolCallId: "call_promote",
            toolName: "workspace.promote_artifact",
            input: {
              path: "scratch/ducks.pptx",
              filename: "ducks.pptx"
            }
          },
          result: {
            status: "success",
            output: {
              artifactId: "art_ducks",
              filename: "ducks.pptx",
              mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            },
            artifacts: [
              {
                artifactId: "art_ducks",
                kind: "presentation.pptx",
                filename: "ducks.pptx",
                mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                metadata: {
                  source: "execution_workspace",
                  workspacePath: "scratch/ducks.pptx"
                }
              }
            ]
          },
          modelOutput: {
            text: "{\"artifactId\":\"art_ducks\"}"
          }
        })
      },
      {
        id: "msg_final",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "Done, I created ducks.pptx.",
        createdAt: "2026-06-15T00:00:03.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_test"
        })
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[1]?.parts).toEqual([
      {
        type: "text",
        text: "Done, I created ducks.pptx.",
        state: "done"
      },
      {
        type: WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
        data: {
          kind: "workspace.promoted_artifacts",
          artifacts: [
            {
              artifactId: "art_ducks",
              kind: "presentation.pptx",
              filename: "ducks.pptx",
              mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
          ]
        }
      }
    ]);
    expect(JSON.stringify(projected[1]?.parts)).not.toContain("scratch/ducks.pptx");
  });

  it("does not surface transient document render artifacts as top-level downloads", () => {
    const result = {
      status: "success",
      output: {
        pageNumber: 1,
        image: {
          artifactId: "art_page",
          mimeType: "image/png"
        }
      },
      artifacts: [
        {
          artifactId: "art_page",
          kind: "document.page_image",
          filename: "document-page-1.png",
          mimeType: "image/png",
          modelVisibility: {
            type: "image",
            mimeType: "image/png"
          }
        }
      ]
    };

    expect(readToolArtifactRefs(result)).toEqual([
      {
        artifactId: "art_page",
        kind: "document.page_image",
        filename: "document-page-1.png",
        mimeType: "image/png"
      }
    ]);
    expect(readSurfacedToolArtifactRefs(result, "view_document_page")).toEqual([]);
  });

  it("does not surface transient document render artifacts on final assistant messages", () => {
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
              toolCallId: "call_page",
              toolName: "view_document_page",
              input: {
                pageNumber: 1
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
        text: "{\"pageNumber\":1}",
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_test",
          toolCall: {
            toolCallId: "call_page",
            toolName: "view_document_page",
            input: {
              pageNumber: 1
            }
          },
          result: {
            status: "success",
            output: {
              pageNumber: 1,
              image: {
                artifactId: "art_page",
                mimeType: "image/png"
              }
            },
            artifacts: [
              {
                artifactId: "art_page",
                kind: "document.page_image",
                filename: "document-page-1.png",
                mimeType: "image/png"
              }
            ]
          },
          modelOutput: {
            text: "{\"pageNumber\":1}"
          }
        })
      },
      {
        id: "msg_final",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "The page looks correct.",
        createdAt: "2026-06-15T00:00:03.000Z",
        metadata: createAssistantFinalMetadata({
          runId: "run_test"
        })
      }
    ];

    const projected = toUiMessages(messages);

    expect(projected[1]?.parts).toEqual([
      {
        type: "text",
        text: "The page looks correct.",
        state: "done"
      }
    ]);
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
    })).toBe("pptx_inspect --view summary");
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
    })).toBe("xlsx_inspect --range Sheet1!A1:C10");
    expect(serializedDetails).toContain("reason handler_failed");
    expect(serializedDetails).not.toContain("/Users/felixpahlke");
    expect(serializedDetails).not.toContain("scratch/workbook.xlsx");
    expect(serializedDetails).not.toContain("Command failed while reading");

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
});

function projectPersistedToolPart(input: {
  toolName: string;
  input: unknown;
  result: Parameters<typeof createToolResultMetadata>[0]["result"];
}): {
  type: string;
  state?: string;
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
    input?: unknown;
    output?: unknown;
  };
}
