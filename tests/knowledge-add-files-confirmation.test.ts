import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asAgentRunId } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./support/chat-server-attachment-harness";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";

// ACCEPT-FIX-11 C-1: the native KB operation supplies its title through the real held tool
// decision and thread projection. No display name is added to the executable file references.
describe("a Knowledge Base file confirmation", () => {
  const { start } = useDataStoreInstance();

  it("names the Knowledge Base in the pending decision and copies nothing before Allow", async () => {
    const attachments = createManagedObjectTestAttachmentCapability();
    const world = await start(true, undefined, undefined, undefined, {
      attachments: attachments.capability
    });
    const knowledgeBase = "confirmation-documents";
    const params = { kind: "knowledge_base", name: knowledgeBase };
    const saved = await world.api.call("assets.put", {
      params,
      payload: {
        expectedRevision: null,
        config: {
          name: knowledgeBase,
          title: "Nordlicht policies",
          description: "Invented test policies.",
          methods: ["keyword"]
        }
      }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      (await world.api.call("assets.publish", { params, payload: { revision: 1 } })).statusCode
    ).toBe(200);
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      expect(
        await world.stores.dataStores.findDataStoreByName({
          clientInstanceId,
          name: `knowledge-base:${knowledgeBase}`
        })
      ).toMatchObject({ status: "ready" });
    });
    const builder = await world.api.call("assets.put", {
      params: { kind: "agent", name: "kb-builder" },
      payload: {
        expectedRevision: null,
        config: {
          name: "kb-builder",
          displayName: "KB builder",
          instructions: "Add attachments when asked.",
          modelProviderId: "local",
          toolNames: ["platform.assets.get"],
          skillNames: [],
          initialPrompts: []
        }
      }
    });
    expect(builder.statusCode, builder.body).toBe(200);
    const conversation = await world.api.call("conversations.create", {
      payload: { title: "Policies" }
    });
    const conversationId = z.object({ id: z.string() }).parse(conversation.json()).id;
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "Nordlicht policy.txt",
      contentType: "text/plain",
      content: "Invented test policy."
    });
    const uploaded = await world.api.call("conversations.draft_attachments.upload", {
      params: { conversationId },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const fileId = z.object({ attachment: z.object({ fileId: z.string() }) }).parse(uploaded.json())
      .attachment.fileId;
    const input = { knowledgeBase, files: [{ conversationId, fileId }] };
    const started = await world.api.call("conversations.runs.start", {
      params: { conversationId },
      payload: {
        idempotencyKey: "kb-confirmation-title",
        agentName: "kb-builder",
        message: { text: `/tool knowledge.add_files ${JSON.stringify(input)}` }
      }
    });
    expect(started.statusCode, started.body).toBe(200);
    const runId = z.object({ run: z.object({ id: z.string() }) }).parse(started.json()).run.id;
    const pending = await eventually(async () => {
      await getTestJobs(world.api).runDue();
      const observations = await world.stores.agentRuns.listRunObservations({
        clientInstanceId,
        runId: asAgentRunId(runId)
      });
      const event = observations
        .map((row) => row.payload)
        .find((event) => event.type === "tool_decision_requested");
      expect(event).toMatchObject({
        targetTitle: "Nordlicht policies",
        operationId: `knowledge.${knowledgeBase}.add_files`,
        inputPreview: { files: input.files }
      });
      return required(event);
    });
    const thread = await world.api.call("conversations.thread.get", { params: { conversationId } });
    expect(thread.body).toContain('"targetTitle":"Nordlicht policies"');
    expect(
      await world.stores.agentRuns.getAgentRun({
        clientInstanceId,
        runId: asAgentRunId(runId)
      })
    ).toMatchObject({ status: "waiting_for_decision" });
    if (pending.type !== "tool_decision_requested") throw new Error("No pending KB decision");
    expect(
      await world.stores.operationRuns.get({
        clientInstanceId,
        id: pending.operationRunId
      })
    ).toMatchObject({ status: "pending_confirmation" });
    const documents = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase }
    });
    expect(documents.statusCode, documents.body).toBe(200);
    expect(documents.json()).toMatchObject({ documents: [] });
    expect(
      (
        await world.api.call("operations.decide", {
          params: { runId: pending.operationRunId },
          payload: { decision: "decline" }
        })
      ).statusCode
    ).toBe(200);
  });
});
