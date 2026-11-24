import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createApiClient,
  type ArtifactPreviewResponse,
  type Message
} from "@work-shape/catalyst-api-client";
import {
  ARTIFACT_PREVIEW_MAX_PAGES,
  asManagedArtifactId,
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@work-shape/catalyst-core";
import {
  ArtifactPreview,
  artifactDisplayFilename,
  artifactDownloadFilename,
  artifactPreviewPollDelayMs,
  ConversationFileDownloadButton,
  conversationFileFromArtifact,
  conversationFileFromResource,
  createArtifactPreviewView,
  createImagePagesArtifactPreviewLoadPlan,
  getArtifactFileType,
  getArtifactPreviewKind,
  getArtifactSourceFallbackKind,
  isWorkspacePromotedArtifactsData,
  readArtifactImagePagesPreview,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs,
  shouldUseLiveArtifactPreviewState,
  toUiMessages,
  type ToolArtifactDownloadRef,
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE
} from "./support/chat-ui";
import {
  readToolActionLabel,
  readToolDetailSections,
  ToolCallPart
} from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { TranslationProvider } from "./chat-ui-render-harness";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("artifacts in the conversation history", () => {
  it("surfaces promoted artifacts on the final message without workspace internals", () => {
    const artifacts = [
      { artifactId: "art_pptx", kind: "presentation.pptx", filename: "board.pptx", mimeType: PPTX },
      {
        artifactId: "art_pdf",
        kind: "document.pdf",
        filename: "summary.pdf",
        mimeType: "application/pdf"
      },
      {
        artifactId: "art_zip",
        kind: "archive.zip",
        filename: "bundle.zip",
        mimeType: "application/zip"
      }
    ];

    const finalParts = toUiMessages(createPromotedArtifactMessages(artifacts)).at(-1)?.parts ?? [];
    const artifactPart = finalParts.find(
      (part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE
    );

    expect(finalParts).toContainEqual({
      type: "text",
      text: "The files are ready.",
      state: "done"
    });
    expect(artifactPart).toEqual({
      type: WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE,
      data: { kind: "workspace.promoted_artifacts", artifacts }
    });
    for (const internal of ["scratch/", "workspacePath", "objectKey", "wcmd_"]) {
      expect(JSON.stringify(artifactPart)).not.toContain(internal);
    }
  });

  it("keeps unpromoted render previews out of final assistant artifact cards", () => {
    const input = {
      command: "pptx_render deck.pptx --out scratch/previews",
      expectedOutputs: [{ path: "scratch/previews/slide-1.png", kind: "image/png" }]
    };
    const projected = toUiMessages([
      createToolCallMessage({ toolCallId: "call_render", toolName: "workspace.exec", input }),
      createToolResultMessage({
        toolCallId: "call_render",
        toolName: "workspace.exec",
        input,
        result: {
          status: "success",
          output: {
            status: "completed",
            changedFiles: [
              {
                path: "scratch/previews/slide-1.png",
                byteSize: 2048,
                checksum: "sha256:preview",
                mimeType: "image/png"
              }
            ],
            promotedArtifacts: []
          }
        }
      }),
      createFinalMessage("The rendered preview looks correct.")
    ]);

    const finalParts = projected.at(-1)?.parts ?? [];
    expect(finalParts.some((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE)).toBe(
      false
    );
  });

  it("replays a workspace command's artifact while redacting its internal details", () => {
    const input = { command: "cat scratch/final-report.pdf && echo shell" };
    const projected = toUiMessages([
      createToolCallMessage({ toolCallId: "call_workspace", toolName: "workspace.exec", input }),
      createToolResultMessage({
        toolCallId: "call_workspace",
        toolName: "workspace.exec",
        input,
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
              artifactId: asManagedArtifactId("art_final"),
              kind: "application/pdf",
              filename: "final-report.pdf",
              mimeType: "application/pdf",
              metadata: { source: "execution_workspace", workspacePath: "scratch/final-report.pdf" }
            }
          ]
        }
      })
    ]);
    const output = (projected[0]?.parts[0] as { output?: unknown } | undefined)?.output;

    expect(readSurfacedToolArtifactRefs(output, "workspace.exec")).toEqual([
      {
        artifactId: "art_final",
        kind: "application/pdf",
        filename: "final-report.pdf",
        mimeType: "application/pdf"
      }
    ]);
    expect(readToolActionLabel({ args: input, result: output, toolName: "workspace.exec" })).toBe(
      "cat [redacted path] && echo shell"
    );
    const details = JSON.stringify(
      readToolDetailSections({
        args: input,
        labels: { input: "Input", output: "Output" },
        result: output,
        toolName: "workspace.exec"
      })
    );
    expect(details).toContain("final-report.pdf");
    for (const internal of [
      "scratch/final-report.pdf",
      "shell stdout preview",
      "shell stderr preview",
      "workspacePath"
    ]) {
      expect(details).not.toContain(internal);
    }
  });

  it("only treats workspace promotion outputs as surfaced download artifacts", () => {
    const internalPreviewResult = {
      status: "success",
      output: { pageNumber: 1 },
      artifacts: [
        {
          artifactId: "art_page_preview",
          kind: "document.page_image",
          filename: "page-1.png",
          mimeType: "image/png"
        }
      ]
    };
    const promoted = {
      artifactId: "art_final_pdf",
      kind: "document.pdf",
      filename: "final.pdf",
      mimeType: "application/pdf"
    };

    expect(readSurfacedToolArtifactRefs(internalPreviewResult, "view_document_page")).toEqual([]);
    expect(readSurfacedToolArtifactRefs(internalPreviewResult, "workspace.preview_images")).toEqual(
      []
    );
    expect(
      readSurfacedToolArtifactRefs(
        { status: "success", artifacts: [promoted] },
        "workspace.promote_artifact"
      )
    ).toEqual([promoted]);
  });

  it("does not offer preview image artifacts as downloads in expanded tool details", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolCallPart, {
          toolName: "workspace.preview_images",
          toolCallId: "call_preview_images",
          args: { artifactId: "art_source_pdf", pages: [1] },
          result: {
            status: "success",
            output: { artifactId: "art_source_pdf", status: "ready", images: [] },
            artifacts: [
              {
                artifactId: "art_page_preview",
                kind: "document.preview_page_image",
                filename: "page-1.png",
                mimeType: "image/png",
                modelVisibility: { type: "image", mimeType: "image/png" }
              }
            ]
          },
          isError: true,
          displayPresentation: "full"
        } as Parameters<typeof ToolCallPart>[0])
      )
    );

    expect(markup).not.toContain("Download");
    expect(markup).not.toContain("art_page_preview");
  });
});

describe("artifact refs", () => {
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
          mimeType: PPTX
        }
      ]
    });

    expect(refs).toEqual([
      {
        artifactId: "art_secret_internal",
        filename: "final-report.pdf",
        mimeType: "application/pdf"
      },
      { artifactId: "art_filename_missing", kind: "presentation.pptx", mimeType: PPTX }
    ]);
    expect(artifactDisplayFilename(refs[1]!)).toBe("Presentation artifact");
    expect(artifactDownloadFilename(refs[1]!)).toBe("artifact.pptx");
    for (const internal of [
      "scratch/",
      "execution-workspaces/private",
      "workspacePath",
      "wcmd_secret"
    ]) {
      expect(JSON.stringify(refs)).not.toContain(internal);
    }
  });

  it("reads an embedded preview up to the worker's page ceiling and no further", () => {
    const read = (count: number) =>
      readToolArtifactRefs({
        status: "success",
        artifacts: [
          {
            artifactId: "art_long_document",
            filename: "long.pdf",
            mimeType: "application/pdf",
            metadata: {
              preview: {
                type: "image_pages",
                format: "png",
                pages: Array.from({ length: count }, (_, index) => ({
                  artifactId: `art_page_${index + 1}`,
                  mimeType: "image/png",
                  pageNumber: index + 1
                }))
              }
            }
          }
        ]
      }).map((ref) => readArtifactImagePagesPreview(ref)?.pages.length);

    expect(read(ARTIFACT_PREVIEW_MAX_PAGES)).toEqual([ARTIFACT_PREVIEW_MAX_PAGES]);
    expect(read(ARTIFACT_PREVIEW_MAX_PAGES + 1)).toEqual([ARTIFACT_PREVIEW_MAX_PAGES]);
  });

  it("keeps only safe embedded preview snapshot fields for optimistic artifact previews", () => {
    const refs = readToolArtifactRefs({
      status: "success",
      artifacts: [
        {
          artifactId: "art_docx",
          kind: "document.docx",
          filename: "outputs/final-report.docx",
          mimeType: DOCX,
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
        mimeType: DOCX,
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
    expect(getArtifactPreviewKind(refs[0]!)).toBe("image-pages");
  });

  it("preserves image-page preview refs on final assistant artifact cards", () => {
    const artifacts = [
      {
        artifactId: "art_docx",
        kind: "document.word",
        filename: "invoice.docx",
        mimeType: DOCX,
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

    const artifactPart = toUiMessages(createPromotedArtifactMessages(artifacts))
      .at(-1)
      ?.parts.find((part) => part.type === WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE);
    const data = artifactPart && "data" in artifactPart ? artifactPart.data : undefined;
    if (!isWorkspacePromotedArtifactsData(data) || data.kind !== "workspace.promoted_artifacts") {
      throw new Error("Expected promoted artifact data");
    }
    const projectedArtifact = data.artifacts[0]!;

    expect(projectedArtifact).toMatchObject(artifacts[0]!);
    expect(readArtifactImagePagesPreview(projectedArtifact)?.pages[0]?.artifactId).toBe(
      "art_docx_page_1"
    );
  });

  it("reads a file's type from its name first, then its media type, then its kind", () => {
    const type = (file: { filename?: string; mimeType?: string; kind?: string }) =>
      getArtifactFileType({ artifactId: "art_file", ...file }).id;

    expect(type({ filename: "export.CSV" })).toBe("csv");
    expect(type({ filename: "upload", mimeType: "application/vnd.ms-excel" })).toBe("spreadsheet");
    // The name decides over the media type, and a word inside the name decides nothing.
    expect(type({ filename: "image-list.xlsx", mimeType: "image/png" })).toBe("spreadsheet");
    expect(type({ filename: "pdf-summary.docx" })).toBe("document");
    expect(type({ kind: "document.pdf" })).toBe("pdf");
    // A JSON file is named JSON, never "Document" (ACCEPT-2e: the chip said "Dokument").
    expect(type({ filename: "rechnung.json" })).toBe("json");
    expect(type({ filename: "upload", mimeType: "application/json" })).toBe("json");
    expect(type({ filename: "clip.mov", mimeType: "video/quicktime" })).toBe("file");
  });

  it("marks previewable artifact types", () => {
    const kind = (filename: string, mimeType: string) =>
      getArtifactPreviewKind({ artifactId: "art_file", filename, mimeType });

    expect(kind("report.pdf", "application/pdf")).toBe("pdf");
    expect(kind("table.csv", "text/csv")).toBe("text");
    expect(kind("workbook.xlsx", XLSX)).toBe("spreadsheet");
    expect(kind("legacy.doc", "application/msword")).toBe("document");
  });

  it("links the download action to the conversation's artifact content", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationFileDownloadButton, {
        client: createApiClient({
          baseUrl: "https://catalyst.example",
          browserManagedDownloads: true
        }),
        conversationId: "conv_test",
        file: conversationFileFromArtifact({
          artifactId: "art_workbook",
          kind: "spreadsheet.workbook",
          filename: "Workbook.xlsx",
          mimeType: XLSX
        }),
        variant: "panel"
      })
    );

    expect(markup).toContain(
      'href="https://catalyst.example/api/v1/conversations/conv_test/artifacts/art_workbook/content"'
    );
  });
});

describe("artifact preview state", () => {
  it("renders a generated JPEG resource without MIME metadata as an inline image", () => {
    const file = conversationFileFromResource({
      resourceType: "generated_file",
      resourceId: "generated_file:art_image",
      title: "IMG_0851.jpeg",
      createdAt: "2026-09-14T12:00:00.000Z",
      updatedAt: "2026-09-14T12:00:00.000Z",
      preview: { kind: "artifact", artifactId: "art_image" },
      download: { kind: "artifact", artifactId: "art_image", filename: "IMG_0851.jpeg" }
    });
    if (file.preview.kind !== "artifact") {
      throw new Error("Expected an artifact preview");
    }
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(ArtifactPreview, {
          artifact: file.preview.artifact,
          client: createApiClient({ baseUrl: "https://example.test" }),
          conversationId: "conversation/1"
        })
      )
    );

    expect(markup).toContain(
      'src="https://example.test/api/v1/conversations/conversation%2F1/artifacts/art_image/content?inline=true"'
    );
  });

  it("backs off while pending, caps the interval, and stops once settled", () => {
    expect(artifactPreviewPollDelayMs({ status: "pending", pendingAttempt: 0 })).toBe(1000);
    expect(artifactPreviewPollDelayMs({ status: "pending", pendingAttempt: 100 })).toBe(5000);
    for (const status of ["ready", "failed", "unsupported"] as const) {
      expect(artifactPreviewPollDelayMs({ status, pendingAttempt: 0 })).toBeUndefined();
    }
  });

  it("uses embedded ready snapshots only until live preview state replaces them", () => {
    const embeddedReady: ArtifactPreviewResponse = {
      status: "ready",
      artifactId: "art_docx",
      type: "image_pages",
      format: "png",
      pages: [{ artifactId: "art_embedded_page", mimeType: "image/png", pageNumber: 1 }]
    };
    const artifact: ToolArtifactDownloadRef = {
      artifactId: "art_docx",
      filename: "final.docx",
      mimeType: DOCX,
      preview: embeddedReady
    };
    const view = (preview: ArtifactPreviewResponse | undefined, refreshing: boolean) =>
      createArtifactPreviewView({
        artifact,
        preview,
        refreshing,
        apiError: false,
        pendingAttempt: 0
      });

    expect(view(embeddedReady, true)).toMatchObject({ kind: "ready", preview: embeddedReady });
    expect(view({ status: "pending", artifactId: "art_docx" }, false)).toEqual({
      kind: "pending",
      pollDelayMs: 1000,
      fallbackKind: undefined
    });
    const liveReady: ArtifactPreviewResponse = {
      ...embeddedReady,
      pages: [{ artifactId: "art_live_page", mimeType: "image/png", pageNumber: 1 }]
    };
    expect(view(liveReady, false)).toMatchObject({ kind: "ready", preview: liveReady });
  });

  it("represents failed, unsupported, and API-failure states without blocking download data", () => {
    const pdfArtifact = {
      artifactId: "art_pdf",
      filename: "report.pdf",
      mimeType: "application/pdf"
    };
    const officeArtifact = { artifactId: "art_docx", filename: "report.docx", mimeType: DOCX };
    const imageArtifact = { artifactId: "art_image", filename: "chart.png", mimeType: "image/png" };
    const view = (
      artifact: ToolArtifactDownloadRef,
      preview: ArtifactPreviewResponse | undefined,
      apiError = false
    ) =>
      createArtifactPreviewView({
        artifact,
        preview,
        refreshing: false,
        apiError,
        pendingAttempt: 0
      });

    expect(getArtifactSourceFallbackKind(officeArtifact)).toBeUndefined();
    expect(
      view(pdfArtifact, {
        status: "unsupported",
        artifactId: "art_pdf",
        errorCode: "unsupported_type"
      })
    ).toEqual({ kind: "unsupported", errorCode: "unsupported_type", fallbackKind: "pdf" });
    expect(
      view(officeArtifact, {
        status: "failed",
        artifactId: "art_docx",
        errorCode: "conversion_failed",
        retryable: true
      })
    ).toEqual({
      kind: "failed",
      errorCode: "conversion_failed",
      retryable: true,
      fallbackKind: undefined
    });
    expect(view(imageArtifact, undefined, true)).toEqual({ kind: "error", fallbackKind: "image" });
  });

  it("uses live preview state only for Office page-image previews", () => {
    const live = (filename: string, mimeType: string) =>
      shouldUseLiveArtifactPreviewState({ artifactId: "art_file", filename, mimeType });

    expect(live("memo.docx", DOCX)).toBe(true);
    expect(live("deck.pptx", PPTX)).toBe(true);
    expect(live("report.pdf", "application/pdf")).toBe(false);
    expect(live("analysis.xlsx", XLSX)).toBe(false);
  });

  it("uses a stable primitive load key for image-page preview fetches", () => {
    const deck = (pages: number[]): ToolArtifactDownloadRef => ({
      artifactId: "art_pptx",
      filename: "deck.pptx",
      mimeType: PPTX,
      preview: {
        status: "ready",
        artifactId: "art_pptx",
        type: "image_pages",
        format: "png",
        pages: pages.map((slideNumber) => ({
          artifactId: `art_slide_${slideNumber}`,
          mimeType: "image/png",
          slideNumber
        }))
      }
    });

    const firstPlan = createImagePagesArtifactPreviewLoadPlan(deck([1, 2]));
    const rerenderedPlan = createImagePagesArtifactPreviewLoadPlan(deck([1, 2]));

    expect(firstPlan?.pages).not.toBe(rerenderedPlan?.pages);
    expect(firstPlan?.key).toBe(rerenderedPlan?.key);
    expect(createImagePagesArtifactPreviewLoadPlan(deck([1, 3]))?.key).not.toBe(firstPlan?.key);
  });
});

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
      input: { command: "create-final-artifacts" }
    }),
    createToolResultMessage({
      toolCallId: "call_promote",
      toolName: "workspace.exec",
      input: { command: "create-final-artifacts" },
      result: {
        status: "success",
        output: {
          status: "completed",
          changedFiles: [],
          promotedArtifacts: artifacts.map((artifact) => ({
            artifactId: asManagedArtifactId(artifact.artifactId),
            path: `scratch/final/${artifact.filename}`,
            kind: artifact.kind,
            mimeType: artifact.mimeType
          }))
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
      toolCalls: [{ toolCallId: input.toolCallId, toolName: input.toolName, input: input.input }]
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
    text: '{"status":"completed"}',
    createdAt: "2026-06-30T00:00:02.000Z",
    metadata: createToolResultMetadata({
      runId: "run_test",
      toolCall: { toolCallId: input.toolCallId, toolName: input.toolName, input: input.input },
      result: input.result,
      modelOutput: { text: '{"status":"completed"}' }
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
    metadata: createAssistantFinalMetadata({ runId: "run_test" })
  };
}
