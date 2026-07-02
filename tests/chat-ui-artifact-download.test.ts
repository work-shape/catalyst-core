import { describe, expect, it } from "vitest";
import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
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
  getArtifactPreviewKind,
  readArtifactImagePagesPreview,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs
} from "../packages/chat-ui/src/tool-artifacts";
import { ToolCallPart } from "../packages/chat-ui/src/tool-call";
import { ToolDisplayPanelProvider } from "../packages/chat-ui/src/tool-display-panel";

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
    const finalParts = projected.at(-1)?.parts ?? [];
    const finalTextPart = finalParts.find((part) => part.type === "text");
    const artifactPart = finalParts.find((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE);

    expect(finalTextPart).toMatchObject({
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

    const finalParts = projected.at(-1)?.parts ?? [];
    expect(finalParts).toContainEqual({
      type: "text",
      text: "The rendered preview looks correct.",
      state: "done"
    });
    expect(finalParts.some((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE)).toBe(false);
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
            source: "execution_workspace",
            workspacePath: "scratch/private/final-report.docx",
            objectKey: "execution-workspaces/private/final-report.docx",
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
        metadata: {
          preview: {
            type: "image_pages",
            format: "png",
            pages: [
              {
                artifactId: "art_page_1",
                kind: "document.preview_page_image",
                filename: "page-1.png",
                mimeType: "image/png",
                pageNumber: 1,
                width: 900,
                height: 1200
              }
            ]
          }
        },
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
    expect(getArtifactPreviewKind(refs[0]!)).toBe("image-pages");
    expect(readArtifactImagePagesPreview(refs[0]!)?.pages[0]?.artifactId).toBe("art_page_1");
    expect(JSON.stringify(refs)).not.toContain("objectKey");
    expect(JSON.stringify(refs)).not.toContain("workspacePath");
    expect(JSON.stringify(refs)).not.toContain("renderer");
    expect(JSON.stringify(refs)).not.toContain("scratch/");
    expect(JSON.stringify(refs)).not.toContain("artifact-previews/private/page-2.png");
  });

  it("preserves image-page preview refs on final assistant artifact cards", () => {
    const artifacts = [
      {
        artifactId: "art_docx",
        kind: "document.word",
        filename: "invoice.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        metadata: {
          preview: {
            type: "image_pages" as const,
            format: "png" as const,
            pages: [
              {
                artifactId: "art_docx_page_1",
                kind: "document.preview_page_image",
                filename: "invoice-page-1.png",
                mimeType: "image/png" as const,
                pageNumber: 1
              }
            ]
          }
        }
      }
    ];

    const projected = toUiMessages(createPromotedArtifactMessages(artifacts));
    const artifactPart = projected
      .at(-1)
      ?.parts.find((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE);
    const data = artifactPart && "data" in artifactPart ? artifactPart.data : undefined;
    const projectedArtifact = data?.kind === "workspace.promoted_artifacts"
      ? data.artifacts[0]
      : undefined;

    expect(projectedArtifact).toMatchObject(artifacts[0]!);
    expect(getArtifactPreviewKind(projectedArtifact!)).toBe("image-pages");
    expect(readArtifactImagePagesPreview(projectedArtifact!)?.pages[0]?.artifactId).toBe("art_docx_page_1");
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
    expect(readSurfacedToolArtifactRefs(internalPreviewResult, "workspace.preview_images")).toEqual([]);
    expect(readSurfacedToolArtifactRefs(promotedResult, "workspace.promote_artifact")).toEqual([
      {
        artifactId: "art_final_pdf",
        kind: "document.pdf",
        filename: "final.pdf",
        mimeType: "application/pdf"
      }
    ]);
  });

  it("does not render preview image artifacts as download cards in expanded tool details", () => {
    const result = {
      status: "success",
      output: {
        artifactId: "art_source_pdf",
        status: "ready",
        maxImages: 1,
        images: [
          {
            sourceArtifactId: "art_source_pdf",
            imageArtifactId: "art_page_preview",
            mimeType: "image/png",
            status: "ready",
            pageNumber: 1
          }
        ],
        warnings: []
      },
      artifacts: [
        {
          artifactId: "art_page_preview",
          kind: "document.preview_page_image",
          filename: "page-1.png",
          mimeType: "image/png",
          modelVisibility: {
            type: "image",
            mimeType: "image/png"
          }
        }
      ]
    };

    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolCallPart, {
          toolName: "workspace.preview_images",
          toolCallId: "call_preview_images",
          args: { artifactId: "art_source_pdf", pages: [1] },
          result,
          isError: true,
          displayPresentation: "full"
        } as Parameters<typeof ToolCallPart>[0])
      )
    );

    expect(markup).toContain("Preview images");
    expect(markup).not.toContain("Download");
    expect(markup).not.toContain("page-1.png");
    expect(markup).not.toContain("art_page_preview");
    expect(markup).not.toContain("document.preview_page_image");
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

  it("marks first-pass previewable artifact types", () => {
    expectPreviewKind("report.pdf", "application/pdf", "pdf");
    expectPreviewKind("chart.png", "image/png", "image");
    expectPreviewKind("notes.txt", "text/plain", "text");
    expectPreviewKind("table.csv", "text/csv", "text");
    expectPreviewKind(
      "workbook.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "spreadsheet"
    );
    expectPreviewKind(
      "letter.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "document"
    );
    expectPreviewKind(
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "presentation"
    );
    expect(getArtifactPreviewKind({
      artifactId: "art_docx_previewable",
      filename: "letter.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      metadata: {
        preview: {
          type: "image_pages",
          format: "png",
          pages: [{ artifactId: "art_page_1", mimeType: "image/png" }]
        }
      }
    })).toBe("image-pages");
    expectPreviewKind(
      "legacy.doc",
      "application/msword",
      undefined
    );
    expectPreviewKind(
      "legacy.ppt",
      "application/vnd.ms-powerpoint",
      undefined
    );
  });
});

function expectBadge(filename: string, mimeType: string, badge: string): void {
  expect(getArtifactFileType({
    artifactId: `art_${filename.replaceAll(/[^a-z0-9]/giu, "_")}`,
    filename,
    mimeType
  }).badge).toBe(badge);
}

function expectPreviewKind(filename: string, mimeType: string, kind: ReturnType<typeof getArtifactPreviewKind>): void {
  expect(getArtifactPreviewKind({
    artifactId: `art_${filename.replaceAll(/[^a-z0-9]/giu, "_")}`,
    filename,
    mimeType
  })).toBe(kind);
}

function createPromotedArtifactMessages(
  artifacts: Array<{
    artifactId: string;
    kind: string;
    filename: string;
    mimeType: string;
    metadata?: Record<string, unknown>;
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
            commandId: "wcmd_private",
            ...artifact.metadata
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
