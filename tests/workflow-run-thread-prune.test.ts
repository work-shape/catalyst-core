import { afterEach, describe, expect, it } from "vitest";
import {
  asConversationId,
  createPlatformId,
  type ConversationId,
  type WorkflowRun
} from "@work-shape/catalyst-core";
import { createManagedObjectAccess } from "@work-shape/catalyst-capability-sdk";
import { createWorkflowRunFiles } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { withTestSql } from "./support/test-sql";
import { readyWorkflows, start } from "./support/workflow-runs";
import type { WorkflowFixture } from "./support/workflow-instance";

// What a run thread keeps once its Workflow run's values are pruned, beyond its messages: the
// tool calls its agent made, the requests they held, and copies of files no handler removed.
// Each keeps what audit needs (ids, status, hashes, sizes, who decided and when) and nothing
// the run carried.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const pdf = new TextEncoder().encode("%PDF-1.7 a signed contract");

async function prepared(options: { attachmentHandler: boolean }) {
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { datasetObjects: objects }
  );
  const handler = createManagedObjectAccess({
    clientInstanceId,
    files: t.stores.files,
    byteStore: objects,
    keyFactory: {
      createFileObjectKey: (input) =>
        `documents/${input.conversationId}/${createPlatformId("obj")}`,
      createArtifactObjectKey: (input) =>
        `documents/${input.conversationId}/${input.kind}/${createPlatformId("obj")}`
    }
  });
  const files = createWorkflowRunFiles({
    clientInstanceId,
    stores: t.stores,
    objects,
    ...(options.attachmentHandler
      ? {
          releaseThread: async (conversationId: ConversationId) => {
            await handler.deleteConversationObjects({
              conversationId,
              deletedAt: new Date().toISOString()
            });
          }
        }
      : {}),
    now: () => new Date()
  });
  const readRun = async (): Promise<WorkflowRun> => {
    const started = await start(t);
    const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
    if (!run) throw new Error("Missing persisted run");
    return run;
  };

  async function threadOf(target: WorkflowRun): Promise<ConversationId> {
    const threadId = asConversationId(createPlatformId("conv"));
    await withTestSql(
      (sql) => sql`insert into conversations (id, client_instance_id, kind, workflow_run_id,
          visibility, title, status, created_at, updated_at, retained_until)
        values (${threadId}, ${clientInstanceId}, 'run_thread', ${target.id}, 'private', 'Check',
          'active', now(), now(), now() + interval '30 days')`
    );
    return threadId;
  }

  /** A copy of a file in a conversation, as an agent gets one, with a text prepared from it. */
  async function copyInto(conversationId: ConversationId, name: string) {
    const copy = await handler.createFile({
      ownerUserId: "usr_owner",
      conversationId,
      filename: name,
      mimeType: "application/pdf",
      bytes: pdf
    });
    await t.stores.files.createConversationAttachment({
      clientInstanceId,
      conversationId,
      fileId: copy.id,
      filename: name,
      mimeType: "application/pdf",
      byteSize: copy.byteSize,
      checksum: copy.checksum,
      status: "ready",
      processingMetadata: { title: name }
    });
    await handler.createArtifact({
      conversationId,
      sourceFileId: copy.id,
      kind: "document.text",
      filename: `${name}.txt`,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(`${name}: a signed contract`),
      metadata: { title: name }
    });
    return copy;
  }

  /**
   * The calls an agent of the thread made: a changing one that answered and needed an
   * approval, a read that kept its counts, and a call still waiting for its approval.
   */
  async function callsIn(conversationId: ConversationId, client: string) {
    const ids = {
      changing: createPlatformId("oprun"),
      reading: createPlatformId("oprun"),
      waiting: createPlatformId("oprun"),
      approved: createPlatformId("apr"),
      pending: createPlatformId("apr"),
      skill: createPlatformId("apr")
    };
    const actor = { kind: "service_principal", id: "svc_workflow", label: "Workflow" };
    const origin = {
      kind: "agent",
      agentRunId: "run_agent",
      agentName: "workflow.check.review",
      toolCallId: "call_1",
      toolName: "crm_update",
      conversationId
    };
    const decided = {
      approved: true,
      decidedBy: "usr_reviewer",
      decidedByLabel: "Rita Reviewer",
      decidedAt: "2026-09-01T10:00:00.000Z",
      comment: `${client} confirmed by phone`
    };
    const heldPayload = (runId: string) => ({
      runId,
      operation: "crm.update",
      effect: "changing",
      input: { customer: client, iban: "DE89370400440532013000" },
      heldInput: { revision: 3, note: client },
      modelRoutes: [{ id: "eu-default", region: "eu" }],
      actor: {
        id: "svc_workflow",
        label: "Workflow",
        authSource: "service",
        scopes: ["crm.write"],
        principal: {
          kind: "service",
          id: "svc_workflow",
          displayLabel: "Workflow",
          authSource: "service"
        }
      },
      origin: { kind: "agent", agentName: "workflow.check.review", toolName: "crm_update" },
      workspaceId: "ws_team",
      expiresAt: "2026-09-02T10:00:00.000Z"
    });
    // A skill change an agent proposed: its payload is the change it applied to the skill.
    const skillPayload = {
      agentName: "workflow.check.review",
      skillName: "contracts",
      operations: [{ type: "append", target: "Checks", content: "Name the contract check" }],
      baseSourceVersion: null
    };
    await withTestSql(async (sql) => {
      await sql`insert into operation_runs (id, client_instance_id, operation, effect, actor_kind,
          actor_id, actor, origin_kind, origin, conversation_id, input_hash, status, decision,
          approval_request_id, output, result_bytes, correlation_id, created_at, updated_at)
        values
          (${ids.changing}, ${clientInstanceId}, 'crm.update', 'changing', 'service_principal',
            'svc_workflow', ${sql.json(actor)}, 'agent', ${sql.json(origin)}, ${conversationId},
            'sha256:in-1', 'done',
            ${sql.json({ mode: "approval", by: "usr_reviewer", byLabel: "Rita Reviewer", at: decided.decidedAt, comment: decided.comment })},
            ${ids.approved}, ${sql.json({ value: { customer: client, status: "updated" } })}, 64,
            'corr-1', now(), now()),
          (${ids.reading}, ${clientInstanceId}, 'crm.search', 'reading', 'service_principal',
            'svc_workflow', ${sql.json(actor)}, 'agent', ${sql.json(origin)}, ${conversationId},
            'sha256:in-2', 'done', null, null,
            ${sql.json({ value: { pages: 2, rows: 40, bytes: 4096 } })}, null, 'corr-2', now(), now()),
          (${ids.waiting}, ${clientInstanceId}, 'crm.update', 'changing', 'service_principal',
            'svc_workflow', ${sql.json(actor)}, 'agent', ${sql.json(origin)}, ${conversationId},
            'sha256:in-3', 'pending_approval', null, ${ids.pending}, null, null, 'corr-3', now(),
            now())`;
      const requestOrigin = {
        conversationId,
        agentRunId: "run_agent",
        toolCallId: "call_1",
        agentName: "workflow.check.review"
      };
      await sql`insert into approval_requests (id, client_instance_id, kind, summary, payload,
          requested_by, origin, status, decision, apply_result, created_at, updated_at)
        values
          (${ids.approved}, ${clientInstanceId}, 'operation_call', 'crm.update',
            ${sql.json(heldPayload(ids.changing))}, ${sql.json({ id: "svc_workflow", displayLabel: "Workflow" })},
            ${sql.json(requestOrigin)}, 'approved', ${sql.json(decided)},
            ${sql.json({ runId: ids.changing, requestId: ids.approved, execution: "failed", output: { customer: client }, error: { code: "UPSTREAM", message: `${client} not found` } })},
            now(), now()),
          (${ids.pending}, ${clientInstanceId}, 'operation_call', 'crm.update',
            ${sql.json(heldPayload(ids.waiting))}, ${sql.json({ id: "svc_workflow", displayLabel: "Workflow" })},
            ${sql.json(requestOrigin)}, 'pending', null, null, now(), now()),
          (${ids.skill}, ${clientInstanceId}, 'skill_change', 'Name the contract check',
            ${sql.json(skillPayload)}, ${sql.json({ id: "svc_workflow", displayLabel: "Workflow" })},
            ${sql.json(requestOrigin)}, 'approved', ${sql.json(decided)},
            ${sql.json({ revision: 4 })}, now(), now())`;
    });
    return ids;
  }

  async function pruneValues(run: WorkflowRun) {
    await withTestSql(
      (sql) =>
        sql`update workflow_runs set status = 'done', finished_at = now() where id = ${run.id}`
    );
    await expect(files.prune(run.id)).resolves.toBe(true);
    await t.stores.workflowRuns.pruneStepRunData({ clientInstanceId, id: run.id, limit: 100 });
    return t.stores.workflowRuns.markRunDataPruned({
      clientInstanceId,
      id: run.id,
      prunedAt: new Date().toISOString()
    });
  }

  return { t, objects, threadOf, copyInto, callsIn, pruneValues, readRun };
}

async function rowsOf(conversationId: ConversationId) {
  return withTestSql(async (sql) => ({
    calls:
      await sql`select * from operation_runs where conversation_id = ${conversationId} order by id`,
    requests:
      await sql`select * from approval_requests where origin->>'conversationId' = ${conversationId} order by id`,
    attachments:
      await sql`select * from conversation_attachments where conversation_id = ${conversationId}`,
    artifacts: await sql`select * from managed_artifacts where conversation_id = ${conversationId}`,
    files: await sql`select f.* from managed_files f
      where f.id in (select file_id from conversation_attachments where conversation_id = ${conversationId})`
  }));
}

describe("a pruned Workflow run's threads", () => {
  it("keep no tool answer, held input or decision comment; who decided and when stays", async () => {
    const { t, threadOf, callsIn, pruneValues, readRun } = await prepared({
      attachmentHandler: true
    });
    const run = await readRun();
    const other = await readRun();
    const thread = await threadOf(run);
    const otherThread = await threadOf(other);
    const ids = await callsIn(thread, "Anna Example");
    await callsIn(otherThread, "Bert Example");
    const otherBefore = await rowsOf(otherThread);

    expect(await pruneValues(run)).toBe(true);

    const left = await rowsOf(thread);
    const call = (id: string) => left.calls.find((row) => row.id === id);
    const request = (id: string) => left.requests.find((row) => row.id === id);
    // The changing call's answer and the comment of its decision go; the call stays.
    expect(call(ids.changing)).toMatchObject({
      status: "done",
      input_hash: "sha256:in-1",
      result_bytes: 64,
      output: null,
      decision: {
        mode: "approval",
        by: "usr_reviewer",
        byLabel: "Rita Reviewer",
        at: "2026-09-01T10:00:00.000Z"
      }
    });
    expect(call(ids.changing)?.decision).not.toHaveProperty("comment");
    // A read keeps only its counts.
    expect(call(ids.reading)?.output).toEqual({ value: { pages: 2, rows: 40, bytes: 4096 } });
    // The approved request keeps which call it held, who decided and when, and its outcome.
    expect(request(ids.approved)).toMatchObject({
      status: "approved",
      summary: "crm.update",
      decision: {
        approved: true,
        decidedBy: "usr_reviewer",
        decidedByLabel: "Rita Reviewer",
        decidedAt: "2026-09-01T10:00:00.000Z"
      },
      apply_result: {
        runId: ids.changing,
        requestId: ids.approved,
        execution: "failed",
        error: { code: "UPSTREAM" }
      }
    });
    expect(request(ids.approved)?.payload).toEqual({
      runId: ids.changing,
      operation: "crm.update",
      effect: "changing",
      actor: { id: "svc_workflow", label: "Workflow" },
      origin: { kind: "agent", agentName: "workflow.check.review", toolName: "crm_update" },
      workspaceId: "ws_team",
      expiresAt: "2026-09-02T10:00:00.000Z",
      inputRemoved: true
    });
    // Nothing of the client is left in a settled call or request.
    const settled = [
      call(ids.changing),
      call(ids.reading),
      request(ids.approved),
      request(ids.skill)
    ];
    expect(JSON.stringify(settled)).not.toMatch(/Anna|DE89/);
    // A request still waiting keeps the input its decision needs, as does its call.
    expect(request(ids.pending)?.payload).toMatchObject({
      input: { customer: "Anna Example" }
    });
    expect(call(ids.waiting)?.status).toBe("pending_approval");
    // A skill change keeps the change it applied, and loses only the decider's comment.
    expect(request(ids.skill)).toMatchObject({
      payload: { skillName: "contracts", operations: [{ type: "append" }] },
      apply_result: { revision: 4 },
      decision: { approved: true, decidedBy: "usr_reviewer", decidedAt: "2026-09-01T10:00:00.000Z" }
    });
    expect(request(ids.skill)?.decision).not.toHaveProperty("comment");
    // The other run's thread is as it was.
    expect(await rowsOf(otherThread)).toEqual(otherBefore);

    // A run pruned by the previous retention version is cleaned on its repair.
    const repaired = await readRun();
    const repairedThread = await threadOf(repaired);
    const repairedIds = await callsIn(repairedThread, "Carla Example");
    await withTestSql(
      (sql) => sql`update workflow_runs set status = 'done', finished_at = now(),
        data_pruned_at = now(), data_prune_version = 2 where id = ${repaired.id}`
    );
    expect(
      await t.stores.workflowRuns.markRunDataPruned({
        clientInstanceId,
        id: repaired.id,
        prunedAt: new Date().toISOString()
      })
    ).toBe(true);
    const after = await rowsOf(repairedThread);
    expect(
      JSON.stringify([
        after.calls.filter((row) => row.id !== repairedIds.waiting),
        after.requests.filter((row) => row.id !== repairedIds.pending)
      ])
    ).not.toContain("Carla");
  });

  it("keep no name of a file copy no attachment handler removed, only its key, size and sha256", async () => {
    const { t, objects, threadOf, copyInto, pruneValues, readRun } = await prepared({
      attachmentHandler: false
    });
    const run = await readRun();
    const thread = await threadOf(run);
    const copy = await copyInto(thread, "contract-anna.pdf");
    // A chat holds a copy of the same name: it belongs to no run.
    const chat = asConversationId(
      (
        await t.expectOk(t.root.id, "conversations.create", { payload: { title: "Contracts" } })
      ).json<{ id: string }>().id
    );
    await copyInto(chat, "contract-anna.pdf");
    // A file the thread and the chat both name is the chat's too, and keeps its name.
    const shared = await copyInto(thread, "shared-bert.pdf");
    await t.stores.files.createConversationAttachment({
      clientInstanceId,
      conversationId: chat,
      fileId: shared.id,
      filename: "shared-bert.pdf",
      mimeType: "application/pdf",
      byteSize: shared.byteSize,
      checksum: shared.checksum,
      status: "ready",
      processingMetadata: { title: "shared-bert.pdf" }
    });
    const chatBefore = await rowsOf(chat);
    const objectsBefore = objects.size;

    expect(await pruneValues(run)).toBe(true);

    const left = await rowsOf(thread);
    const own = {
      attachments: left.attachments.filter((row) => row.file_id === copy.id),
      artifacts: left.artifacts.filter((row) => row.source_file_id === copy.id),
      files: left.files.filter((row) => row.id === copy.id)
    };
    expect(JSON.stringify(own)).not.toContain("contract-anna");
    expect(JSON.stringify([left.attachments, left.artifacts])).not.toMatch(
      /contract-anna|shared-bert/
    );
    expect(own.attachments).toHaveLength(1);
    expect(own.attachments[0]).toMatchObject({
      file_id: copy.id,
      byte_size: pdf.byteLength,
      checksum: copy.checksum,
      processing_metadata: {}
    });
    expect(own.artifacts).toHaveLength(1);
    expect(own.artifacts[0]).toMatchObject({ filename: null, metadata: {} });
    // The bytes no handler removed are still named by their key, so they can be found.
    expect(own.files).toEqual([
      expect.objectContaining({
        id: copy.id,
        object_key: copy.objectKey,
        byte_size: pdf.byteLength,
        checksum: copy.checksum
      })
    ]);
    expect(left.files.find((row) => row.id === shared.id)?.filename).toBe("shared-bert.pdf");
    expect(objects.size).toBe(objectsBefore);
    // The chat's copies are as they were.
    expect(await rowsOf(chat)).toEqual(chatBefore);
  });
});
