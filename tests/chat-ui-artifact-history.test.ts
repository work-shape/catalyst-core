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
  readToolDetailSections
} from "../packages/chat-ui/src/tool-call";
import {
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs
} from "../packages/chat-ui/src/tool-artifacts";

describe("chat UI artifact history projection", () => {
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
    const finalParts = projected.at(-1)?.parts ?? [];

    expect(finalParts).toContainEqual({
      type: "text",
      text: "Done, I created ducks.pptx.",
      state: "done"
    });
    expect(finalParts).toContainEqual({
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
    });
    const artifactPart = finalParts.find((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE);
    expect(JSON.stringify(artifactPart)).not.toContain("scratch/ducks.pptx");
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
    const finalParts = projected.at(-1)?.parts ?? [];

    expect(finalParts).toContainEqual({
      type: "text",
      text: "The page looks correct.",
      state: "done"
    });
    expect(finalParts.some((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE)).toBe(false);
  });
});
