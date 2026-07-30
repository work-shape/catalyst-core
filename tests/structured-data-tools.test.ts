import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asMessageId,
  asToolCallId,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createStructuredDataToolDefinitions,
  InProcessToolExecution,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";

describe("structured_data.publish", () => {
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
      output: { revision: 2, operation: "replace" }
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
      output: { revision: 2, operation: "patch" }
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

  it("rejects cross-conversation sources and invalid keys", async () => {
    const harness = await createHarness();
    const otherConversation = await harness.store.createConversation({
      clientInstanceId: harness.clientInstanceId,
      ownerUserId: "user-1",
      ownerExternalUserId: "user-1",
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
                sources: [{ attachmentId: attachment.id }]
              }
            ]
          }
        ]
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "validation_failed",
        message: expect.stringContaining(attachment.id)
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

async function createHarness() {
  const clientInstanceId = asClientInstanceId(
    `structured_data_${globalThis.crypto.randomUUID()}`
  );
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Structured data",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const tools = createStructuredDataToolDefinitions({ store });
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools }),
    getAgentToolNames: () => ["structured_data.publish"]
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
      store.listStructuredDataResources({
        clientInstanceId,
        conversationId: conversation.id
      }),
    async run(input: unknown) {
      const request = {
        toolName: "structured_data.publish",
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

async function createSentAttachment(
  store: InMemoryPlatformStore,
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  conversationId: Parameters<InMemoryPlatformStore["createConversationAttachment"]>[0]["conversationId"]
) {
  const file = await store.createManagedFile({
    clientInstanceId,
    ownerUserId: "user-1",
    filename: "source.pdf",
    mimeType: "application/pdf",
    byteSize: 1,
    checksum: `sha256:${globalThis.crypto.randomUUID()}`,
    objectKey: `private/${globalThis.crypto.randomUUID()}`
  });
  const attachment = await store.createConversationAttachment({
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
  await store.claimReadyDraftAttachmentsForMessage({
    clientInstanceId,
    conversationId,
    messageId: asMessageId(`msg_${globalThis.crypto.randomUUID()}`),
    claimedAt: new Date().toISOString()
  });
  return attachment;
}
