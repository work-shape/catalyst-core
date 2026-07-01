import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asConversationAttachmentId,
  asManagedArtifactId,
  asManagedFileId,
  asMessageId,
  readAssistantWebSourceMetadata,
  type AttachmentManifest,
  type ChatMessage,
  type JsonObject,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createModelVisibleToolOutput,
  createToolResultMetadata,
  projectAgentVisibleHistory,
  selectRecentCompleteHistory
} from "../packages/agent-runtime/src/model-context-projection";
import { modelContentImages, modelContentText } from "@vivd-catalyst/model-provider";

describe("model context projection", () => {
  it("round-trips assistant web sources and citations through message metadata", () => {
    const metadata = createAssistantFinalMetadata({
      runId: asAgentRunId("run_sources"),
      sources: [
        {
          id: "web_source_1",
          url: "https://example.com/source",
          title: "Example",
          provider: "openai-native"
        }
      ],
      citations: [
        {
          sourceId: "web_source_1",
          characterRange: {
            start: 4,
            end: 11
          }
        }
      ]
    });

    expect(readAssistantWebSourceMetadata(metadata)).toEqual({
      sources: [
        {
          id: "web_source_1",
          url: "https://example.com/source",
          title: "Example",
          provider: "openai-native"
        }
      ],
      citations: [
        {
          sourceId: "web_source_1",
          characterRange: {
            start: 4,
            end: 11
          }
        }
      ]
    });
  });

  it("replays tool calls and model-visible output without exposing private result fields", async () => {
    const runId = asAgentRunId("run_projection");
    const toolCall = {
      toolCallId: "toolcall_projection",
      toolName: "data.warehouse.render_view",
      input: {
        query: "select count(*) from customer_accounts",
        htmlTemplate: "<div>{{ROWS_JSON}}</div>"
      }
    };
    const result: ToolExecutionResult = {
      status: "success",
      output: {
        displayed: true,
        message: "Data has been displayed to the user."
      },
      privateOutput: {
        rows: [{ customerName: "Private Customer", balance: 1200000 }]
      },
      display: {
        kind: "private_hydrated_view",
        version: 1,
        data: {
          html: "<section>Private Customer balance: 1200000</section>"
        }
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, modelContextOptions());
    const messages = [
      createMessage("user", "Show me the account dashboard"),
      createMessage("assistant", "", createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })),
      createMessage(
        "tool",
        modelOutput.text,
        createToolResultMetadata({
          runId,
          toolCall,
          result,
          modelOutput
        })
      )
    ];

    const projected = await projectAgentVisibleHistory(messages, modelContextOptions());
    const projectedJson = JSON.stringify(projected);

    expect(projected).toHaveLength(3);
    expect(projected[1]).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          toolCallId: "toolcall_projection",
          toolName: "data.warehouse.render_view",
          input: {
            query: "select count(*) from customer_accounts"
          }
        }
      ]
    });
    expect(projected[2]).toMatchObject({
      role: "tool",
      toolCallId: "toolcall_projection"
    });
    expect(modelContentText(projected[2]?.content ?? "")).toContain("Data has been displayed to the user.");
    expect(JSON.stringify(messages[2]?.metadata)).toContain("Private Customer");
    expect(projectedJson).not.toContain("Private Customer");
    expect(projectedJson).not.toContain("1200000");
    expect(projectedJson).not.toContain("private_hydrated_view");
  });

  it("replays tool errors so the model can correct invalid tool calls", async () => {
    const runId = asAgentRunId("run_projection_error");
    const toolCall = {
      toolCallId: "toolcall_projection_error",
      toolName: "demo.echo",
      input: {
        text: 42
      }
    };
    const result: ToolExecutionResult = {
      status: "failed",
      error: {
        code: "validation_failed",
        message: "Tool input or output failed validation",
        details: {
          issues: [{ path: "text", message: "Expected string, received number" }]
        }
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, modelContextOptions());
    const projected = await projectAgentVisibleHistory(
      [
        createMessage("assistant", "", createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })),
        createMessage(
          "tool",
          modelOutput.text,
          createToolResultMetadata({
            runId,
            toolCall,
            result,
            modelOutput
          })
        )
      ],
      modelContextOptions()
    );

    expect(projected[1]).toMatchObject({
      role: "tool",
      toolCallId: "toolcall_projection_error"
    });
    expect(modelContentText(projected[1]?.content ?? "")).toContain("validation_failed");
    expect(modelContentText(projected[1]?.content ?? "")).toContain("Expected string");
  });

  it("marks cancelled assistant final messages as incomplete in model-visible history", async () => {
    const runId = asAgentRunId("run_cancelled_projection");
    const projected = await projectAgentVisibleHistory(
      [
        createMessage(
          "assistant",
          "I started answering but was cut off",
          createAssistantFinalMetadata({
            runId,
            finishStatus: "cancelled",
            cancellationReason: "user_requested"
          })
        )
      ],
      modelContextOptions()
    );

    const content = modelContentText(projected[0]?.content ?? "");
    expect(content).toContain("I started answering but was cut off");
    expect(content).toContain("Assistant response stopped by the user before completion");
    expect(content).toContain("incomplete");
    expect(content).not.toContain("user_requested");
  });

  it("keeps tool-call blocks complete when selecting a bounded active history", async () => {
    const runId = asAgentRunId("run_projection_bounded");
    const toolCall = {
      toolCallId: "toolcall_projection_bounded",
      toolName: "view_document_page",
      input: {
        fileId: "file_contract",
        pageNumber: 6
      }
    };
    const result: ToolExecutionResult = {
      status: "success",
      output: {
        pageNumber: 6,
        status: "loaded"
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, modelContextOptions());
    const messages = [
      createMessage("user", "Earlier request"),
      createMessage("assistant", "", createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })),
      createMessage(
        "tool",
        modelOutput.text,
        createToolResultMetadata({
          runId,
          toolCall,
          result,
          modelOutput
        })
      ),
      createMessage("assistant", "Page 6 loaded."),
      createMessage("user", "Did it work?")
    ];

    const selected = selectRecentCompleteHistory(messages, 4);

    expect(selected.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "user"
    ]);
    expect(selected[0]?.metadata).toMatchObject({
      agentRuntime: {
        kind: "assistant_tool_calls"
      }
    });
  });

  it("drops orphan tool outputs from projected provider context", async () => {
    const runId = asAgentRunId("run_projection_orphan");
    const toolCall = {
      toolCallId: "toolcall_projection_orphan",
      toolName: "view_document_page",
      input: {
        fileId: "file_contract",
        pageNumber: 6
      }
    };
    const result: ToolExecutionResult = {
      status: "success",
      output: {
        pageNumber: 6,
        status: "loaded"
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, modelContextOptions());
    const projected = await projectAgentVisibleHistory(
      [
        createMessage(
          "tool",
          modelOutput.text,
          createToolResultMetadata({
            runId,
            toolCall,
            result,
            modelOutput
          })
        ),
        createMessage("user", "Did it work?")
      ],
      modelContextOptions()
    );

    expect(projected.map((message) => message.role)).toEqual(["user"]);
  });

  it("projects user attachment manifests without embedding document text", async () => {
    const manifest: AttachmentManifest = {
      version: 1,
      attachments: [
        {
          kind: "document",
          fileId: asManagedFileId("file_contract"),
          attachmentId: asConversationAttachmentId("att_contract"),
          filename: "contract.pdf",
          byteSize: 1200,
          status: "ready",
          readable: true,
          modelContext: {
            section: "Attached documents",
            text: '- contract.pdf (fileId: file_contract, status: ready, size: 1200 bytes, format: pdf, words: 250). Use read_document({ "fileId": "file_contract", "mode": "full" }) to read the full prepared text. Use view_document_page({ "fileId": "file_contract", "pageNumber": 1 }) to visually inspect a specific PDF page when layout or images matter.'
          },
          metadata: {
            fileId: asManagedFileId("file_contract"),
            filename: "contract.pdf",
            byteSize: 1200,
            format: "pdf",
            wordCount: 250,
            warnings: []
          }
        }
      ]
    };
    const projected = await projectAgentVisibleHistory(
      [
        createMessage("user", "Summarize the attachment", {
          agentRuntime: {
            version: 1,
            kind: "user_message",
            attachmentManifest: manifest as unknown as JsonObject
          }
        })
      ],
      modelContextOptions()
    );

    const content = modelContentText(projected[0]?.content ?? "");
    expect(content).toContain("contract.pdf");
    expect(content).toContain('read_document({ "fileId": "file_contract", "mode": "full" })');
    expect(content).toContain("view_document_page");
    expect(content).not.toContain("Raw contract body");
  });

  it("projects user image attachments into visual context without embedding bytes in metadata", async () => {
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const manifest: AttachmentManifest = {
      version: 1,
      attachments: [
        {
          kind: "image",
          fileId: asManagedFileId("file_receipt"),
          attachmentId: asConversationAttachmentId("att_receipt"),
          filename: "receipt.png",
          mimeType: "image/png",
          byteSize: imageBytes.byteLength,
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
            fileId: asManagedFileId("file_receipt"),
            filename: "receipt.png",
            mimeType: "image/png",
            byteSize: imageBytes.byteLength,
            format: "png",
            checksum: "checksum"
          }
        }
      ]
    };
    const metadata: JsonObject = {
      agentRuntime: {
        version: 1,
        kind: "user_message",
        attachmentManifest: manifest as unknown as JsonObject
      }
    };
    const projected = await projectAgentVisibleHistory(
      [createMessage("user", "What does the receipt show?", metadata)],
      {
        ...modelContextOptions(),
        clientInstanceId: asClientInstanceId("projection-client"),
        fileReader: {
          async readFile() {
            return {
              bytes: imageBytes,
              mimeType: "image/png"
            };
          }
        }
      }
    );

    expect(modelContentText(projected[0]?.content ?? "")).toContain("[Attached images]");
    expect(modelContentImages(projected[0]?.content ?? "")[0]?.data).toEqual(imageBytes);
    expect(JSON.stringify(metadata)).not.toContain("iVBOR");
  });

  it("loads model-visible image artifacts without storing base64 in history metadata", async () => {
    const runId = asAgentRunId("run_projection_image");
    const artifactId = asManagedArtifactId("art_page_image");
    const toolCall = {
      toolCallId: "toolcall_projection_image",
      toolName: "view_document_page",
      input: {
        fileId: "file_contract",
        pageNumber: 2
      }
    };
    const result: ToolExecutionResult = {
      status: "success",
      output: {
        fileId: "file_contract",
        pageNumber: 2,
        pageCount: 4,
        dpi: 160,
        image: {
          artifactId,
          mimeType: "image/png",
          byteSize: 8,
          checksum: "checksum"
        }
      },
      artifacts: [
        {
          artifactId,
          kind: "document.page_image",
          mimeType: "image/png",
          modelVisibility: {
            type: "image",
            mimeType: "image/png"
          },
          metadata: {
            pageNumber: 2,
            dpi: 160
          }
        }
      ]
    };
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const options = {
      ...modelContextOptions(),
      clientInstanceId: asClientInstanceId("projection-client"),
      artifactReader: {
        async readArtifact() {
          return {
            bytes: imageBytes,
            mimeType: "image/png"
          };
        }
      }
    };

    const modelOutput = await createModelVisibleToolOutput(result, options);
    const metadata = createToolResultMetadata({
      runId,
      toolCall,
      result,
      modelOutput
    });
    const projected = await projectAgentVisibleHistory(
      [
        createMessage("assistant", "", createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })),
        createMessage("tool", modelOutput.text, metadata)
      ],
      options
    );

    expect(modelContentText(modelOutput.content)).toContain("[Visual context loaded]");
    expect(modelContentImages(modelOutput.content)).toHaveLength(1);
    expect(modelContentImages(projected[1]?.content ?? "")[0]?.data).toEqual(imageBytes);
    expect(JSON.stringify(metadata)).not.toContain("iVBOR");
  });
});

function createMessage(
  role: ChatMessage["role"],
  text: string,
  metadata?: JsonObject
): ChatMessage {
  return {
    id: asMessageId(`msg_${role}_${text.length}_${Math.random().toString(36).slice(2)}`),
    clientInstanceId: asClientInstanceId("projection-client"),
    conversationId: asConversationId("conv_projection"),
    role,
    text,
    createdAt: "2026-06-14T00:00:00.000Z",
    metadata
  };
}

function modelContextOptions() {
  return {
    toolOutput: {
      maxTokens: 60000
    }
  };
}
