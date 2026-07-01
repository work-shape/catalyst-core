import { describe, expect, it } from "vitest";
import type { Message } from "@vivd-catalyst/api-client";
import {
  asManagedArtifactId,
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@vivd-catalyst/core";
import { toUiMessages } from "../packages/chat-ui/src/assistant-ui-adapter";
import {
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
  artifactDisplayFilename,
  artifactDownloadFilename,
  getArtifactFileType,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs
} from "../packages/chat-ui/src/tool-artifacts";

describe("chat UI artifact download cards", () => {
  it("surfaces promoted final artifacts on the final assistant message for common formats", () => {
    const artifacts = [
      {
        artifactId: "art_pptx",
        kind: "presentation.pptx",
        filename: "board-update.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      },
      {
        artifactId: "art_pdf",
        kind: "document.pdf",
        filename: "summary.pdf",
        mimeType: "application/pdf"
      },
      {
        artifactId: "art_docx",
        kind: "document.docx",
        filename: "memo.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },
      {
        artifactId: "art_xlsx",
        kind: "spreadsheet.xlsx",
        filename: "analysis.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      },
      {
        artifactId: "art_csv",
        kind: "table.csv",
        filename: "export.csv",
        mimeType: "text/csv"
      },
      {
        artifactId: "art_image",
        kind: "image.png",
        filename: "chart.png",
        mimeType: "image/png"
      },
      {
        artifactId: "art_zip",
        kind: "archive.zip",
        filename: "bundle.zip",
        mimeType: "application/zip"
      }
    ];

    const projected = toUiMessages(createPromotedArtifactMessages(artifacts));
    const finalParts = projected[1]?.parts ?? [];
    const artifactPart = finalParts.find((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE);

    expect(finalParts[0]).toMatchObject({
      type: "text",
      text: "The files are ready."
    });
    expect(artifactPart).toEqual({
      type: WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
      data: {
        kind: "workspace.promoted_artifacts",
        artifacts
      }
    });
    expect(
      artifacts.map((artifact) => getArtifactFileType(artifact).badge)
    ).toEqual(["PPT", "PDF", "DOC", "XLS", "CSV", "IMG", "ZIP"]);
    expect(JSON.stringify(artifactPart)).not.toContain("scratch/");
    expect(JSON.stringify(artifactPart)).not.toContain("workspacePath");
    expect(JSON.stringify(artifactPart)).not.toContain("objectKey");
    expect(JSON.stringify(artifactPart)).not.toContain("wcmd_");
  });

  it("keeps unpromoted render previews out of final assistant artifact cards", () => {
    const projected = toUiMessages([
      createToolCallMessage({
        toolCallId: "call_render",
        toolName: "workspace.exec",
        input: {
          command: "pptx_render deck.pptx --out scratch/previews",
          expectedOutputs: [{ path: "scratch/previews/slide-1.png", kind: "image/png" }]
        }
      }),
      createToolResultMessage({
        toolCallId: "call_render",
        toolName: "workspace.exec",
        input: {
          command: "pptx_render deck.pptx --out scratch/previews",
          expectedOutputs: [{ path: "scratch/previews/slide-1.png", kind: "image/png" }]
        },
        result: {
          status: "success",
          output: {
            status: "completed",
            exitCode: 0,
            stdoutPreview: "",
            stderrPreview: "",
            durationMs: 120,
            changedFiles: [
              {
                path: "scratch/previews/slide-1.png",
                byteSize: 2048,
                checksum: "sha256:preview",
                mimeType: "image/png"
              }
            ],
            promotedArtifacts: [],
            truncated: {
              stdout: false,
              stderr: false
            }
          }
        }
      }),
      createFinalMessage("The rendered preview looks correct.")
    ]);

    expect(projected[1]?.parts).toEqual([
      {
        type: "text",
        text: "The rendered preview looks correct.",
        state: "done"
      }
    ]);
  });

  it("sanitizes artifact card refs and never falls back to showing internal ids as filenames", () => {
    const refs = readToolArtifactRefs({
      status: "success",
      artifacts: [
        {
          artifactId: "art_secret_internal",
          kind: "execution-workspaces/private",
          filename: "scratch/private/final-report.pdf",
          mimeType: "application/pdf",
          metadata: {
            source: "execution_workspace",
            workspacePath: "scratch/private/final-report.pdf",
            objectKey: "execution-workspaces/private/final-report.pdf",
            commandId: "wcmd_secret"
          }
        },
        {
          artifactId: "art_filename_missing",
          kind: "presentation.pptx",
          filename: "art_internal_name",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
      ]
    });

    expect(refs).toEqual([
      {
        artifactId: "art_secret_internal",
        filename: "final-report.pdf",
        mimeType: "application/pdf"
      },
      {
        artifactId: "art_filename_missing",
        kind: "presentation.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      }
    ]);
    expect(artifactDisplayFilename(refs[1]!)).toBe("Presentation artifact");
    expect(artifactDownloadFilename(refs[1]!)).toBe("artifact.pptx");
    expect(JSON.stringify(refs)).not.toContain("scratch/");
    expect(JSON.stringify(refs)).not.toContain("execution-workspaces/private");
    expect(JSON.stringify(refs)).not.toContain("workspacePath");
    expect(JSON.stringify(refs)).not.toContain("wcmd_secret");
  });

  it("keeps only safe embedded preview snapshot fields for optimistic artifact previews", () => {
    const refs = readToolArtifactRefs({
      status: "success",
      artifacts: [
        {
          artifactId: "art_docx",
          kind: "document.docx",
          filename: "outputs/final-report.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          metadata: {
            preview: {
              type: "image_pages",
              format: "png",
              renderer: "libreoffice",
              rendererVersion: "internal-renderer-version",
              pages: [
                {
                  artifactId: "art_page_1",
                  kind: "document.preview_page_image",
                  filename: "scratch/previews/page-1.png",
                  mimeType: "image/png",
                  pageNumber: 1,
                  width: 900,
                  height: 1200,
                  objectKey: "artifact-previews/private/page-1.png",
                  workspacePath: "scratch/previews/page-1.png"
                },
                {
                  artifactId: "artifact-previews/private/page-2.png",
                  filename: "page-2.png",
                  mimeType: "image/png",
                  pageNumber: 2
                }
              ]
            }
          }
        }
      ]
    });

    expect(refs).toEqual([
      {
        artifactId: "art_docx",
        kind: "document.docx",
        filename: "final-report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        preview: {
          status: "ready",
          artifactId: "art_docx",
          type: "image_pages",
          format: "png",
          pages: [
            {
              artifactId: "art_page_1",
              filename: "page-1.png",
              mimeType: "image/png",
              pageNumber: 1,
              width: 900,
              height: 1200
            }
          ]
        }
      }
    ]);
    expect(artifactDownloadFilename(refs[0]!)).toBe("final-report.docx");
    expect(JSON.stringify(refs)).not.toContain("objectKey");
    expect(JSON.stringify(refs)).not.toContain("workspacePath");
    expect(JSON.stringify(refs)).not.toContain("renderer");
    expect(JSON.stringify(refs)).not.toContain("scratch/");
    expect(JSON.stringify(refs)).not.toContain("artifact-previews/private/page-2.png");
  });

  it("only treats workspace promotion outputs as surfaced download artifacts", () => {
    const internalPreviewResult = {
      status: "success",
      output: {
        pageNumber: 1
      },
      artifacts: [
        {
          artifactId: "art_page_preview",
          kind: "document.page_image",
          filename: "page-1.png",
          mimeType: "image/png"
        }
      ]
    };
    const promotedResult = {
      status: "success",
      artifacts: [
        {
          artifactId: "art_final_pdf",
          kind: "document.pdf",
          filename: "final.pdf",
          mimeType: "application/pdf"
        }
      ]
    };

    expect(readSurfacedToolArtifactRefs(internalPreviewResult, "view_document_page")).toEqual([]);
    expect(readSurfacedToolArtifactRefs(promotedResult, "workspace.promote_artifact")).toEqual([
      {
        artifactId: "art_final_pdf",
        kind: "document.pdf",
        filename: "final.pdf",
        mimeType: "application/pdf"
      }
    ]);
  });

  it("classifies artifact badge types without proprietary assets", () => {
    expectBadge("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PPT");
    expectBadge("report.pdf", "application/pdf", "PDF");
    expectBadge("letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "DOC");
    expectBadge("workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLS");
    expectBadge("table.csv", "text/csv", "CSV");
    expectBadge("plot.webp", "image/webp", "IMG");
    expectBadge("exports.zip", "application/zip", "ZIP");
    expectBadge("notes.txt", "text/plain", "DOC");
    expectBadge("unknown.bin", "application/octet-stream", "FILE");
  });
});

function expectBadge(filename: string, mimeType: string, badge: string): void {
  expect(getArtifactFileType({
    artifactId: `art_${filename.replaceAll(/[^a-z0-9]/giu, "_")}`,
    filename,
    mimeType
  }).badge).toBe(badge);
}

function createPromotedArtifactMessages(
  artifacts: Array<{
    artifactId: string;
    kind: string;
    filename: string;
    mimeType: string;
  }>
): Message[] {
  return [
    createToolCallMessage({
      toolCallId: "call_promote",
      toolName: "workspace.exec",
      input: {
        command: "create-final-artifacts",
        expectedOutputs: artifacts.map((artifact) => ({
          path: `scratch/final/${artifact.filename}`,
          kind: artifact.kind,
          promote: true
        }))
      }
    }),
    createToolResultMessage({
      toolCallId: "call_promote",
      toolName: "workspace.exec",
      input: {
        command: "create-final-artifacts"
      },
      result: {
        status: "success",
        output: {
          status: "completed",
          exitCode: 0,
          stdoutPreview: "created files",
          stderrPreview: "",
          durationMs: 500,
          changedFiles: [],
          promotedArtifacts: artifacts.map((artifact) => ({
            artifactId: asManagedArtifactId(artifact.artifactId),
            path: `scratch/final/${artifact.filename}`,
            kind: artifact.kind,
            mimeType: artifact.mimeType
          })),
          truncated: {
            stdout: false,
            stderr: false
          }
        },
        artifacts: artifacts.map((artifact) => ({
          ...artifact,
          artifactId: asManagedArtifactId(artifact.artifactId),
          metadata: {
            source: "execution_workspace",
            workspacePath: `scratch/final/${artifact.filename}`,
            objectKey: `execution-workspaces/private/${artifact.filename}`,
            commandId: "wcmd_private"
          }
        }))
      }
    }),
    createFinalMessage("The files are ready.")
  ];
}

function createToolCallMessage(input: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): Message {
  return {
    id: `msg_${input.toolCallId}`,
    conversationId: "conv_test",
    clientInstanceId: "client_test",
    role: "assistant",
    text: "",
    createdAt: "2026-06-30T00:00:01.000Z",
    metadata: createAssistantToolCallsMetadata({
      runId: "run_test",
      toolCalls: [
        {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          input: input.input
        }
      ]
    })
  };
}

function createToolResultMessage(input: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result: Parameters<typeof createToolResultMetadata>[0]["result"];
}): Message {
  return {
    id: `msg_${input.toolCallId}_result`,
    conversationId: "conv_test",
    clientInstanceId: "client_test",
    role: "tool",
    text: "{\"status\":\"completed\"}",
    createdAt: "2026-06-30T00:00:02.000Z",
    metadata: createToolResultMetadata({
      runId: "run_test",
      toolCall: {
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input
      },
      result: input.result,
      modelOutput: {
        text: "{\"status\":\"completed\"}"
      }
    })
  };
}

function createFinalMessage(text: string): Message {
  return {
    id: "msg_final",
    conversationId: "conv_test",
    clientInstanceId: "client_test",
    role: "assistant",
    text,
    createdAt: "2026-06-30T00:00:03.000Z",
    metadata: createAssistantFinalMetadata({
      runId: "run_test"
    })
  };
}
