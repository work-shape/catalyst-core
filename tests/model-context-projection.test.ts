import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asConversationAttachmentId,
  asManagedFileId,
  asMessageId,
  type AttachmentManifest,
  type ChatMessage,
  type JsonObject,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import {
  createAssistantToolCallsMetadata,
  createModelVisibleToolOutput,
  createToolResultMetadata,
  projectAgentVisibleHistory
} from "../packages/agent-runtime/src/model-context-projection";

describe("model context projection", () => {
  it("replays tool calls and model-visible output without exposing private result fields", () => {
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
    const modelOutput = createModelVisibleToolOutput(result, modelContextOptions());
    const messages = [
      createMessage("user", "Show me the account dashboard"),
      createMessage("assistant", "", createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })),
      createMessage(
        "tool",
        modelOutput.content,
        createToolResultMetadata({
          runId,
          toolCall,
          result,
          modelOutput
        })
      )
    ];

    const projected = projectAgentVisibleHistory(messages, modelContextOptions());
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
    expect(projected[2]?.content).toContain("Data has been displayed to the user.");
    expect(JSON.stringify(messages[2]?.metadata)).toContain("Private Customer");
    expect(projectedJson).not.toContain("Private Customer");
    expect(projectedJson).not.toContain("1200000");
    expect(projectedJson).not.toContain("private_hydrated_view");
  });

  it("replays tool errors so the model can correct invalid tool calls", () => {
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
    const modelOutput = createModelVisibleToolOutput(result, modelContextOptions());
    const projected = projectAgentVisibleHistory(
      [
        createMessage("assistant", "", createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })),
        createMessage(
          "tool",
          modelOutput.content,
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
    expect(projected[1]?.content).toContain("validation_failed");
    expect(projected[1]?.content).toContain("Expected string");
  });

  it("projects user attachment manifests without embedding document text", () => {
    const manifest: AttachmentManifest = {
      version: 1,
      attachments: [
        {
          fileId: asManagedFileId("file_contract"),
          attachmentId: asConversationAttachmentId("att_contract"),
          filename: "contract.pdf",
          byteSize: 1200,
          status: "ready",
          readable: true,
          readToolName: "read_document",
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
    const projected = projectAgentVisibleHistory(
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

    expect(projected[0]?.content).toContain("contract.pdf");
    expect(projected[0]?.content).toContain('read_document({ "fileId": "file_contract" })');
    expect(projected[0]?.content).not.toContain("Raw contract body");
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
