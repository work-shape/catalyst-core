import { describe, expect, it } from "vitest";
import type { Message } from "@vivd-catalyst/api-client";
import {
  asManagedArtifactId,
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createToolResultMetadata,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import { toUiMessages } from "../packages/chat-ui/src/assistant/assistant-ui-adapter";
import { readToolDisplayPayloadFromToolResult } from "../packages/chat-ui/src/domain-ui-widgets";
import {
  readToolActionLabel,
  readToolDetailSections,
  readToolDisplayProjection
} from "@vivd-catalyst/chat-ui/tool-call";
import { readToolArtifactRefs } from "../packages/chat-ui/src/tool-artifacts";
import { readToolSurfaceRefs } from "../packages/chat-ui/src/tool-surfaces";

describe("chat UI message history projection", () => {
  it("uses one structured result payload for live and persisted display surfaces", () => {
    const structuredResult = {
      key: "review",
      kind: "demo.review",
      schemaVersion: 2,
      title: "Current review",
      data: { status: "complete" }
    };
    const result: ToolExecutionResult = {
      status: "success",
      output: { saved: true },
      structuredResult
    };

    expect(readToolDisplayPayloadFromToolResult(result)).toEqual({
      kind: "demo.review",
      version: 2,
      mode: "side_panel",
      title: "Current review",
      data: { status: "complete" }
    });
    expect(
      readToolSurfaceRefs(result, { toolCallId: "call_review", toolName: "demo.review" })
    ).toEqual([
      {
        surfaceId: "tool:call_review",
        toolCallId: "call_review",
        toolName: "demo.review",
        title: "Current review",
        display: {
          kind: "demo.review",
          version: 2,
          mode: "side_panel",
          title: "Current review",
          data: { status: "complete" }
        }
      }
    ]);

    const messages: Message[] = [
      {
        id: "msg_tool_call_review",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "",
        createdAt: "2026-06-15T00:00:01.000Z",
        metadata: createAssistantToolCallsMetadata({
          runId: "run_review",
          toolCalls: [
            {
              toolCallId: "call_review",
              toolName: "demo.review",
              input: {}
            }
          ]
        })
      },
      {
        id: "msg_tool_result_review",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "tool",
        text: '{"saved":true}',
        createdAt: "2026-06-15T00:00:02.000Z",
        metadata: createToolResultMetadata({
          runId: "run_review",
          toolCall: {
            toolCallId: "call_review",
            toolName: "demo.review",
            input: {}
          },
          result,
          modelOutput: { text: '{"saved":true}' }
        })
      },
      {
        id: "msg_final_review",
        conversationId: "conv_test",
        clientInstanceId: "client_test",
        role: "assistant",
        text: "Review saved.",
        createdAt: "2026-06-15T00:00:03.000Z",
        metadata: createAssistantFinalMetadata({ runId: "run_review" })
      }
    ];

    expect(toUiMessages(messages)[0]?.parts).toContainEqual({
      type: "data-workspace-promoted-surfaces",
      data: {
        kind: "workspace.promoted_surfaces",
        surfaces: [
          {
            surfaceId: "tool:call_review",
            toolCallId: "call_review",
            toolName: "demo.review",
            title: "Current review",
            display: {
              kind: "demo.review",
              version: 2,
              mode: "side_panel",
              title: "Current review",
              data: { status: "complete" }
            }
          }
        ]
      }
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
        text: '{"displayed":true}',
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
            text: '{"displayed":true}'
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
    expect(projected[1]?.metadata).toEqual({
      custom: { completedRunId: "run_test" }
    });
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
          stdoutPreview: '{"slides":[{"secret":"raw stdout json should stay hidden"}]}',
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

    expect(
      readToolActionLabel({
        args: toolPart.input,
        result: toolPart.output,
        toolName: "workspace.exec"
      })
    ).toBe("pptx_inspect --view summary [redacted path] && cat [redacted path]");
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
            artifactId: asManagedArtifactId("art_final"),
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

    expect(
      readToolActionLabel({
        args: imported.input,
        result: imported.output,
        toolName: "workspace.import_files"
      })
    ).toBe("Imported 1 file");
    expect(
      readToolActionLabel({
        args: read.input,
        result: read.output,
        toolName: "workspace.read_file"
      })
    ).toBe("Read large-result.json");
    expect(
      readToolActionLabel({
        args: promoted.input,
        result: promoted.output,
        toolName: "workspace.promote_artifact"
      })
    ).toBe("Promoted final-report.pdf");
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
    expect(
      readToolActionLabel({
        args: toolPart.input,
        result: toolPart.output,
        toolName: "workspace.exec"
      })
    ).toBe("xlsx_inspect --range Sheet1!A1:C10 [redacted path]");
    expect(serializedDetails).toContain("reason handler_failed");
    expect(serializedDetails).toContain("Command failed while reading");
    expect(serializedDetails).not.toContain("/Users/felixpahlke");
    expect(serializedDetails).not.toContain("scratch/workbook.xlsx");

    const timeoutDetails = JSON.stringify(
      readToolDetailSections({
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
      })
    );
    const cancelledDetails = JSON.stringify(
      readToolDetailSections({
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
      })
    );

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
      {
        label: "Output",
        value: JSON.stringify({ status: "success", output: "hello back" }, null, 2)
      }
    ]);
  });

  it("projects user-facing tool titles and call subjects", () => {
    expect(
      readToolDisplayProjection({
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
      })
    ).toEqual({
      actionLabel: "PDF",
      technicalName: "read_skill",
      title: "Read instructions"
    });

    expect(
      readToolDisplayProjection({
        args: { name: "pdf" },
        locale: "de",
        result: undefined,
        toolName: "read_skill"
      })
    ).toMatchObject({
      actionLabel: "PDF",
      technicalName: "read_skill",
      title: "Anleitung lesen"
    });

    // The tool keeps its name `show_view`; a person reads "Widget" in both languages.
    for (const locale of ["en", "de"] as const) {
      expect(
        readToolDisplayProjection({
          args: { title: "Open tasks" },
          locale,
          result: undefined,
          toolName: "show_view"
        })
      ).toEqual({ actionLabel: "Open tasks", technicalName: "show_view", title: "Widget" });
    }

    // The fact sheet steps say what happens, in both languages.
    const step = (toolName: string, locale: "en" | "de") =>
      readToolDisplayProjection({ args: {}, locale, result: undefined, toolName }).title;
    expect(step("structured_data.publish", "en")).toBe("Update the fact sheet");
    expect(step("structured_data.read", "en")).toBe("Read the fact sheet");
    expect(step("structured_result.read", "en")).toBe("Reopen an earlier result");
    expect(step("structured_data.publish", "de")).toBe("Faktenblatt aktualisieren");
    expect(step("structured_data.read", "de")).toBe("Faktenblatt lesen");
    expect(step("structured_result.read", "de")).toBe("Früheres Ergebnis öffnen");

    expect(
      readToolDisplayProjection({
        args: {},
        locale: "en",
        result: undefined,
        toolName: "demo.workflow_summary"
      })
    ).toEqual({
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
