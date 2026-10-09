import type { PlatformStores } from "@vivd-catalyst/core";
import { claimAttachmentsForStoredMessage } from "./support/test-store";
import { type TestStore, createTestInstance } from "./support/test-instance";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asMessageId,
  asToolCallId,
  createToolResultMetadata,
  type StructuredDataPublicationReviewer,
  type ToolExecutionContext
} from "@vivd-catalyst/core";

import {
  createStructuredDataToolDefinitions,
  InProcessToolExecution,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";

describe("structured_data.publish", () => {
  it("reviews a fully materialized replacement and publishes with model-visible warnings", async () => {
    let proposal: Parameters<StructuredDataPublicationReviewer>[0] | undefined;
    const harness = await createHarness((input) => {
      proposal = input;
      return ["Reconcile the proposed value"];
    });
    const attachment = await createSentAttachment(
      harness.store,
      harness.clientInstanceId,
      harness.conversation.id
    );
    await harness.store.conversations.appendMessage({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      role: "assistant",
      text: "Durable evidence"
    });

    await expect(
      harness.run({
        resourceKey: "claim_data",
        title: "Claim data",
        operation: "replace",
        sections: [
          {
            key: "person",
            label: "Person",
            fields: [
              {
                key: "name",
                label: "Name",
                value: "Ada",
                sources: [{ fileId: attachment.fileId, page: 2 }]
              }
            ]
          }
        ]
      })
    ).resolves.toMatchObject({
      status: "success",
      output: {
        revision: 1,
        warnings: ["Reconcile the proposed value"],
        message: expect.stringContaining("Reconcile the proposed value")
      }
    });
    expect(proposal).toMatchObject({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      resourceKey: "claim_data",
      title: "Claim data",
      state: {
        title: "Claim data",
        sections: [
          {
            fields: [
              {
                value: "Ada",
                sources: [{ attachmentId: attachment.id, page: 2 }]
              }
            ]
          }
        ]
      },
      attachments: [{ id: attachment.id, fileId: attachment.fileId, filename: "source.pdf" }]
    });
    expect(proposal?.messages.some((message) => message.text === "Durable evidence")).toBe(true);
    await expect(harness.resources()).resolves.toEqual([
      expect.objectContaining({
        revision: 1,
        state: expect.objectContaining({
          sections: [
            expect.objectContaining({
              fields: [expect.objectContaining({ value: "Ada" })]
            })
          ]
        })
      })
    ]);
  });

  it("reviews a materialized patch and persists it despite warnings", async () => {
    const proposals: Parameters<StructuredDataPublicationReviewer>[0][] = [];
    const harness = await createHarness((input) => {
      proposals.push(input);
      return input.state.sections[0]?.fields[0]?.value === "Grace" ? ["Conflicting value"] : [];
    });
    await harness.run({
      resourceKey: "claim_data",
      title: "Claim data",
      operation: "replace",
      sections: [
        {
          key: "person",
          label: "Person",
          fields: [{ key: "name", label: "Full name", value: "Ada" }]
        }
      ]
    });

    await expect(
      harness.run({
        resourceKey: "claim_data",
        operation: "patch",
        set: [{ sectionKey: "person", fieldKey: "name", value: "Grace" }]
      })
    ).resolves.toMatchObject({
      status: "success",
      output: {
        revision: 2,
        warnings: ["Conflicting value"],
        message: expect.stringContaining("Conflicting value")
      }
    });
    expect(proposals.at(-1)?.state.sections[0]?.fields[0]?.value).toBe("Grace");
    await expect(harness.resources()).resolves.toEqual([
      expect.objectContaining({
        revision: 2,
        state: expect.objectContaining({
          sections: [
            expect.objectContaining({
              fields: [expect.objectContaining({ value: "Grace" })]
            })
          ]
        })
      })
    ]);
  });

  it("creates and fully replaces a resource with server-owned revisions", async () => {
    const harness = await createHarness();
    const first = await harness.run({
      resourceKey: "claim_data",
      title: "Claim data",
      operation: "replace",
      sections: [
        {
          key: "person",
          label: "Person",
          fields: [{ key: "name", label: "Name", value: "Ada" }]
        }
      ]
    });
    expect(first).toMatchObject({
      status: "success",
      output: { resourceKey: "claim_data", revision: 1, operation: "replace" },
      display: {
        kind: "structured_data.resource",
        version: 1,
        mode: "side_panel",
        displayId: expect.stringMatching(/^structured-data:/u),
        title: "Claim data",
        data: {
          structuredDataResourceId: expect.any(String),
          resourceKey: "claim_data",
          revision: 1
        }
      },
      auditSummary: {
        action: "structured_data.published",
        subject: "claim_data",
        metadata: {
          operation: "replace",
          sectionCount: 1,
          fieldCount: 1,
          sourceRefCount: 0
        }
      }
    });
    if (first.status === "success") {
      expect(first.output).not.toHaveProperty("warnings");
    }

    const second = await harness.run({
      resourceKey: "claim_data",
      title: "Updated claim",
      operation: "replace",
      sections: [
        {
          key: "summary",
          label: "Summary",
          fields: [{ key: "status", label: "Status", value: true }]
        }
      ]
    });
    expect(second).toMatchObject({
      status: "success",
      output: { revision: 2, operation: "replace" },
      display: {
        displayId: first.status === "success" ? first.display?.displayId : undefined,
        title: "Updated claim",
        data: {
          resourceKey: "claim_data",
          revision: 2
        }
      }
    });
    await expect(harness.resources()).resolves.toEqual([
      expect.objectContaining({
        title: "Updated claim",
        revision: 2,
        state: {
          title: "Updated claim",
          sections: [
            {
              key: "summary",
              label: "Summary",
              fields: [{ key: "status", label: "Status", value: true }]
            }
          ]
        }
      })
    ]);
  });

  it("patches existing fields, appends new fields, and removes empty sections", async () => {
    const harness = await createHarness();
    await harness.run({
      resourceKey: "claim_data",
      title: "Claim data",
      operation: "replace",
      sections: [
        {
          key: "person",
          label: "Person",
          fields: [{ key: "name", label: "Full name", value: "Ada" }]
        },
        {
          key: "obsolete",
          label: "Obsolete",
          fields: [{ key: "remove_me", label: "Remove me", value: "yes" }]
        }
      ]
    });

    const result = await harness.run({
      resourceKey: "claim_data",
      operation: "patch",
      set: [
        { sectionKey: "person", fieldKey: "name", value: "Grace" },
        { sectionKey: "person", fieldKey: "city", label: "City", value: "Berlin" }
      ],
      remove: [{ sectionKey: "obsolete", fieldKey: "remove_me" }]
    });
    expect(result).toMatchObject({
      status: "success",
      output: { revision: 2, operation: "patch" },
      display: {
        title: "Claim data",
        data: {
          resourceKey: "claim_data",
          revision: 2
        }
      }
    });
    const [resource] = await harness.resources();
    expect(resource?.state.sections).toEqual([
      {
        key: "person",
        label: "Person",
        fields: [
          { key: "name", label: "Full name", value: "Grace" },
          { key: "city", label: "City", value: "Berlin" }
        ]
      }
    ]);
  });

  it("publishes, updates, clears, and reads optional field attention", async () => {
    const harness = await createHarness();
    const attachment = await createSentAttachment(
      harness.store,
      harness.clientInstanceId,
      harness.conversation.id
    );
    await harness.run({
      resourceKey: "claim_data",
      title: "Claim data",
      operation: "replace",
      sections: [
        {
          key: "person",
          label: "Person",
          fields: [
            {
              key: "name",
              label: "Name",
              value: "Ada",
              sources: [{ fileId: attachment.fileId, page: 2 }],
              attention: { reason: "uncertain", message: "Scan is hard to read" }
            }
          ]
        }
      ]
    });

    await expect(
      harness.run({ resourceKey: "claim_data" }, "structured_data.read")
    ).resolves.toMatchObject({
      status: "success",
      output: {
        resourceKey: "claim_data",
        revision: 1,
        sections: [
          {
            fields: [
              {
                value: "Ada",
                attention: { reason: "uncertain", message: "Scan is hard to read" },
                sources: [{ fileId: attachment.fileId, filename: "source.pdf", page: 2 }]
              }
            ]
          }
        ]
      }
    });

    await harness.run({
      resourceKey: "claim_data",
      operation: "patch",
      set: [
        {
          sectionKey: "person",
          fieldKey: "name",
          value: "Ada",
          attention: { reason: "conflicting" }
        }
      ]
    });
    expect((await harness.resources())[0]?.state.sections[0]?.fields[0]?.attention).toEqual({
      reason: "conflicting"
    });

    await harness.run({
      resourceKey: "claim_data",
      operation: "patch",
      set: [{ sectionKey: "person", fieldKey: "name", value: "Ada", attention: null }]
    });
    expect((await harness.resources())[0]?.state.sections[0]?.fields[0]).not.toHaveProperty(
      "attention"
    );
  });

  it("rejects patches for unknown resources and sections", async () => {
    const harness = await createHarness();
    await expect(
      harness.run({
        resourceKey: "missing",
        operation: "patch",
        set: [{ sectionKey: "person", fieldKey: "name", value: "Ada" }]
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed", message: expect.stringContaining("replace") }
    });
    await harness.run({
      resourceKey: "claim_data",
      title: "Claim data",
      operation: "replace",
      sections: []
    });
    await expect(
      harness.run({
        resourceKey: "claim_data",
        operation: "patch",
        set: [{ sectionKey: "missing", fieldKey: "name", value: "Ada" }]
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: expect.stringContaining("missing")
      }
    });
  });

  it("maps model-visible file ids to conversation attachment sources", async () => {
    const harness = await createHarness();
    const attachment = await createSentAttachment(
      harness.store,
      harness.clientInstanceId,
      harness.conversation.id
    );

    await expect(
      harness.run({
        resourceKey: "claim_data",
        title: "Claim data",
        operation: "replace",
        sections: [
          {
            key: "person",
            label: "Person",
            fields: [
              {
                key: "name",
                label: "Name",
                value: "Ada",
                sources: [{ fileId: attachment.fileId, page: 2 }]
              }
            ]
          }
        ]
      })
    ).resolves.toMatchObject({ status: "success" });
    await expect(harness.resources()).resolves.toEqual([
      expect.objectContaining({
        state: expect.objectContaining({
          sections: [
            expect.objectContaining({
              fields: [
                expect.objectContaining({
                  sources: [{ attachmentId: attachment.id, page: 2 }]
                })
              ]
            })
          ]
        })
      })
    ]);
  });

  it("rejects cross-conversation source files and invalid keys", async () => {
    const harness = await createHarness();
    const otherConversation = await harness.store.createConversationForTesting({
      clientInstanceId: harness.clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Other",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const attachment = await createSentAttachment(
      harness.store,
      harness.clientInstanceId,
      otherConversation.id
    );

    await expect(
      harness.run({
        resourceKey: "claim_data",
        title: "Claim data",
        operation: "replace",
        sections: [
          {
            key: "person",
            label: "Person",
            fields: [
              {
                key: "name",
                label: "Name",
                value: "Ada",
                sources: [{ fileId: attachment.fileId }]
              }
            ]
          }
        ]
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: expect.stringContaining(attachment.fileId)
      }
    });
    await expect(
      harness.run({
        resourceKey: "Bad-Key",
        title: "Claim data",
        operation: "replace",
        sections: []
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed" }
    });
  });

  it("rejects duplicate section and field keys in a replace", async () => {
    const harness = await createHarness();
    const section = (key: string, fieldKeys: string[]) => ({
      key,
      label: "Section",
      fields: fieldKeys.map((fieldKey) => ({ key: fieldKey, label: "Field", value: "x" }))
    });

    await expect(
      harness.run({
        resourceKey: "claim_data",
        title: "Claim data",
        operation: "replace",
        sections: [section("person", ["name"]), section("person", ["age"])]
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed" }
    });
    await expect(
      harness.run({
        resourceKey: "claim_data",
        title: "Claim data",
        operation: "replace",
        sections: [section("person", ["name", "name"])]
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed" }
    });
  });
});

describe("structured_result.read", () => {
  it("reads the current revision and includes legacy analysis publications", async () => {
    const harness = await createHarness();
    await appendResult(harness, {
      status: "success",
      output: { legacy: true },
      display: {
        kind: "example.review",
        version: 1,
        title: "Review",
        resource: { category: "analysis", key: "review-key" },
        data: { status: "old" }
      }
    });
    await appendResult(harness, {
      status: "success",
      output: { revision: 2 },
      structuredResult: {
        key: "review-key",
        kind: "example.review",
        schemaVersion: 2,
        title: "Current review",
        data: { status: "current" }
      }
    });

    await expect(
      harness.run({ resourceKey: "review-key" }, "structured_result.read")
    ).resolves.toMatchObject({
      status: "success",
      output: {
        key: "review-key",
        kind: "example.review",
        schemaVersion: 2,
        title: "Current review",
        revision: 2,
        data: { status: "current" }
      }
    });
    await expect(
      harness.run({ resourceKey: "missing" }, "structured_result.read")
    ).resolves.toMatchObject({ status: "failed", error: { code: "validation_failed" } });
  });
});

async function createHarness(publicationReviewer?: StructuredDataPublicationReviewer) {
  const clientInstanceId = asClientInstanceId(`structured_data_${globalThis.crypto.randomUUID()}`);
  const store = (await createTestInstance()).stores;
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Structured data",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const tools = createStructuredDataToolDefinitions({ store, publicationReviewer });
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools }),
    getAgentToolNames: () => tools.map((tool) => tool.name)
  });
  const context: ToolExecutionContext = {
    clientInstanceId,
    correlationId: "corr_structured_data",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
  return {
    clientInstanceId,
    store,
    conversation,
    resources: () =>
      store.structuredData.listStructuredDataResources({
        clientInstanceId,
        conversationId: conversation.id
      }),
    async run(input: unknown, toolName = "structured_data.publish") {
      const request = {
        toolName,
        toolCallId: asToolCallId(`call_${globalThis.crypto.randomUUID()}`),
        agentRunId: asAgentRunId(`run_${globalThis.crypto.randomUUID()}`),
        conversationId: conversation.id,
        agentName: "structured_data_agent",
        input
      };
      const authorization = await execution.authorize(request, context);
      if (authorization.status !== "allowed") {
        throw new Error(authorization.reason);
      }
      return execution.execute({ ...request, authorization }, context);
    }
  };
}

function appendResult(
  harness: Awaited<ReturnType<typeof createHarness>>,
  result: Parameters<typeof createToolResultMetadata>[0]["result"]
) {
  return harness.store.conversations.appendMessage({
    clientInstanceId: harness.clientInstanceId,
    conversationId: harness.conversation.id,
    role: "tool",
    text: JSON.stringify({ status: result.status }),
    metadata: createToolResultMetadata({
      runId: "run_structured_result",
      toolCall: {
        toolCallId: "call_structured_result",
        toolName: "test.result",
        input: {}
      },
      result,
      modelOutput: { text: JSON.stringify({ status: result.status }) }
    })
  });
}

async function createSentAttachment(
  store: PlatformStores,
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  conversationId: Parameters<
    TestStore["files"]["createConversationAttachment"]
  >[0]["conversationId"]
) {
  const file = await store.files.createManagedFile({
    clientInstanceId,
    ownerUserId: "user-1",
    filename: "source.pdf",
    mimeType: "application/pdf",
    byteSize: 1,
    checksum: `sha256:${globalThis.crypto.randomUUID()}`,
    objectKey: `private/${globalThis.crypto.randomUUID()}`
  });
  const attachment = await store.files.createConversationAttachment({
    clientInstanceId,
    conversationId,
    fileId: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    checksum: file.checksum,
    status: "ready",
    format: "pdf"
  });
  await claimAttachmentsForStoredMessage(store, {
    clientInstanceId,
    conversationId,
    messageId: asMessageId(`msg_${globalThis.crypto.randomUUID()}`),
    claimedAt: new Date().toISOString()
  });
  return attachment;
}
