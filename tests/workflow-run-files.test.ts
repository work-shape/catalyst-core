import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_RUN_FILE_MAX_BYTES,
  asConversationId,
  createPlatformId,
  type ConversationId,
  type WorkflowRun
} from "@work-shape/catalyst-core";
import { createManagedObjectAccess } from "@work-shape/catalyst-capability-sdk";
import { createWorkflowRunFiles, runFilesOwner } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { withTestSql } from "./support/test-sql";
import { readyWorkflows, start } from "./support/workflow-runs";
import type { WorkflowFixture } from "./support/workflow-instance";

// The files of a Workflow run on real Postgres: kept below the run's prefix and owned by the
// run, named in step data by a reference only that run's steps may use, and deleted with the
// run's values.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const pdf = new TextEncoder().encode("%PDF-1.7 a signed contract");

async function prepared() {
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { datasetObjects: objects }
  );
  // The copies an agent gets lie where the attachment handlers keep their files, and the
  // handler removes them as document processing does when a conversation is deleted.
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
  const readRun = async (): Promise<WorkflowRun> => {
    const started = await start(t);
    const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
    if (!run) throw new Error("Missing persisted run");
    return run;
  };
  const files = createWorkflowRunFiles({
    clientInstanceId,
    stores: t.stores,
    objects,
    releaseThread: async (conversationId) => {
      await handler.deleteConversationObjects({
        conversationId,
        deletedAt: new Date().toISOString()
      });
    },
    now: () => new Date()
  });
  return { t, objects, handler, files, run: await readRun(), readRun };
}

describe("the files of a Workflow run", () => {
  it("keeps a file below the run's prefix, owned by the run, and answers its reference", async () => {
    const { t, objects, files, run } = await prepared();
    const reference = await files.create({
      run,
      filename: "contract.pdf",
      mimeType: "application/pdf",
      content: pdf
    });
    expect(reference).toMatchObject({
      name: "contract.pdf",
      mimeType: "application/pdf",
      bytes: pdf.byteLength
    });
    const [file] = await t.stores.files.listOwnedManagedFilesById({
      clientInstanceId,
      owner: runFilesOwner(run.id),
      fileIds: [reference.$file]
    });
    expect(file).toMatchObject({ status: "available", ownerUserId: run.principal.id });
    expect(file?.objectKey.startsWith(`workflow-runs/${run.id}/files/`)).toBe(true);
    expect(objects.size).toBe(1);
    await expect(files.check(run, [reference])).resolves.toBeUndefined();
    // The audit names size, digest and type, never the file's name.
    const kept = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.file_kept"
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.metadata).toMatchObject({ runId: run.id, bytes: pdf.byteLength });
    expect(JSON.stringify(kept)).not.toContain("contract.pdf");
    const read = await files.read(reference.$file);
    expect(read && new TextDecoder().decode(read.bytes)).toBe("%PDF-1.7 a signed contract");
  });

  it("refuses a step a file of another run, or one named otherwise than it is stored", async () => {
    const { files, run, readRun } = await prepared();
    const other = await readRun();
    const reference = await files.create({
      run: other,
      filename: "contract.pdf",
      mimeType: "application/pdf",
      content: pdf
    });
    await expect(files.check(run, [reference])).rejects.toMatchObject({
      code: "file_reference_invalid"
    });
    await expect(
      files.check(other, [{ ...reference, bytes: reference.bytes + 1 }])
    ).rejects.toMatchObject({ code: "file_reference_invalid" });
    await expect(
      files.check(other, [{ ...reference, mimeType: "text/html" }])
    ).rejects.toMatchObject({ code: "file_reference_invalid" });
  });

  it("refuses an empty file, one over the cap, and a run that has ended", async () => {
    const { t, files, run } = await prepared();
    const keep = (content: Uint8Array, target = run) =>
      files.create({ run: target, filename: "a.pdf", mimeType: "application/pdf", content });
    await expect(keep(new Uint8Array())).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(keep(new Uint8Array(WORKFLOW_RUN_FILE_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
    await expect(keep(pdf, { ...run, status: "done" })).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(
      await t.stores.files.ownedManagedFileBytes({ clientInstanceId, owner: runFilesOwner(run.id) })
    ).toBe(0);
  });

  it("deletes the files of a pruned run with their bytes and leaves another run's", async () => {
    const { t, objects, files, run, readRun } = await prepared();
    const other = await readRun();
    const reference = await files.create({
      run,
      filename: "contract.pdf",
      mimeType: "application/pdf",
      content: pdf
    });
    const kept = await files.create({
      run: other,
      filename: "kept.pdf",
      mimeType: "application/pdf",
      content: pdf
    });
    await expect(files.prune(run.id)).resolves.toBe(true);

    await expect(files.read(reference.$file)).resolves.toBeUndefined();
    expect(
      await t.stores.files.ownedManagedFileBytes({ clientInstanceId, owner: runFilesOwner(run.id) })
    ).toBe(0);
    expect(objects.size).toBe(1);
    await expect(files.check(other, [kept])).resolves.toBeUndefined();
  });

  it("leaves no text, file name or bytes of a pruned run in its run threads, and its audit as it was", async () => {
    const { t, objects, handler, files, run, readRun } = await prepared();
    const other = await readRun();
    const ownerUserId = run.principal.id;

    /** A run thread as an agent step leaves it: its task and answer, and a prepared copy. */
    async function threadOf(target: WorkflowRun, name: string): Promise<ConversationId> {
      const reference = await files.create({
        run: target,
        filename: name,
        mimeType: "application/pdf",
        content: pdf
      });
      const threadId = asConversationId(createPlatformId("conv"));
      await withTestSql(async (sql) => {
        await sql`insert into conversations (id, client_instance_id, kind, workflow_run_id, visibility,
            title, status, created_at, updated_at, retained_until)
          values (${threadId}, ${clientInstanceId}, 'run_thread', ${target.id}, 'private', 'Check',
            'active', now(), now(), now() + interval '30 days')`;
        await sql`insert into messages (id, client_instance_id, conversation_id, role, text, metadata, created_at)
          values (${createPlatformId("msg")}, ${clientInstanceId}, ${threadId}, 'user',
            ${`Check ${name}`}, ${sql.json({ fileName: name })}, now()),
            (${createPlatformId("msg")}, ${clientInstanceId}, ${threadId}, 'assistant',
            ${`${name} is signed`}, '{}', now())`;
      });
      await copyInto(threadId, name, reference.$file);
      return threadId;
    }
    async function copyInto(conversationId: ConversationId, name: string, runFileId?: string) {
      const copy = await handler.createFile({
        ownerUserId,
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
        processingMetadata: { title: name, ...(runFileId ? { runFileId } : {}) }
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
    }

    const pruned = await threadOf(run, "contract-anna.pdf");
    const kept = await threadOf(other, "contract-bert.pdf");
    // A chat with a file of the same name and bytes belongs to no run.
    const chat = asConversationId(
      (
        await t.expectOk(t.root.id, "conversations.create", { payload: { title: "Contracts" } })
      ).json<{ id: string }>().id
    );
    await copyInto(chat, "contract-anna.pdf");
    const auditBefore = await withTestSql(
      (sql) =>
        sql`select * from audit_events where client_instance_id = ${clientInstanceId} order by id`
    );
    const objectsBefore = objects.size;

    await withTestSql(
      (sql) =>
        sql`update workflow_runs set status = 'done', finished_at = now() where id = ${run.id}`
    );
    await expect(files.prune(run.id)).resolves.toBe(true);
    await t.stores.workflowRuns.pruneStepRunData({ clientInstanceId, id: run.id, limit: 100 });
    expect(
      await t.stores.workflowRuns.markRunDataPruned({
        clientInstanceId,
        id: run.id,
        prunedAt: new Date().toISOString()
      })
    ).toBe(true);

    const left = await withTestSql(async (sql) => {
      const rows = async (conversationId: ConversationId) => ({
        messages: await sql`select * from messages where conversation_id = ${conversationId}`,
        attachments:
          await sql`select * from conversation_attachments where conversation_id = ${conversationId}`,
        artifacts:
          await sql`select * from managed_artifacts where conversation_id = ${conversationId}`
      });
      return {
        pruned: await rows(pruned),
        kept: await rows(kept),
        chat: await rows(chat),
        files:
          await sql`select * from managed_files where client_instance_id = ${clientInstanceId}`,
        audit:
          await sql`select * from audit_events where client_instance_id = ${clientInstanceId} order by id`
      };
    });
    // The thread keeps its messages as rows, empty, and nothing of the copy.
    expect(JSON.stringify(left.pruned)).not.toContain("contract-anna");
    expect(left.pruned.messages.map((message) => message.text)).toEqual(["", ""]);
    expect(left.pruned.attachments).toEqual([]);
    expect(left.pruned.artifacts).toEqual([]);
    expect(JSON.stringify(left.files)).not.toMatch(new RegExp(`${run.id}|${pruned}`));
    // The other run's thread, the chat and their files are as they were.
    expect(left.kept.messages.map((message) => message.text).sort()).toEqual([
      "Check contract-bert.pdf",
      "contract-bert.pdf is signed"
    ]);
    for (const rows of [left.kept, left.chat]) {
      expect(rows.attachments.map((row) => row.status)).toEqual(["ready"]);
      expect(rows.artifacts.map((row) => row.status)).toEqual(["available"]);
    }
    expect(left.chat.attachments[0]?.filename).toBe("contract-anna.pdf");
    // The other run's file and two copies, with two artifacts; the pruned run's three are gone.
    expect(left.files.filter((file) => file.status !== "deleted")).toHaveLength(3);
    expect(objects.size).toBe(objectsBefore - 3);
    // The audit keeps what it had: ids, sizes and digests, never a name.
    expect(left.audit).toEqual(auditBefore);
    expect(
      left.audit.filter(
        (event) => event.type === "workflow_run.file_kept" && event.subject === run.id
      )
    ).toHaveLength(1);

    // A run the previous retention version pruned kept its copies' rows: its repair takes them.
    await copyInto(pruned, "contract-anna.pdf");
    await handler.deleteConversationObjects({
      conversationId: pruned,
      deletedAt: new Date().toISOString()
    });
    await withTestSql(
      (sql) => sql`update workflow_runs set data_prune_version = 1 where id = ${run.id}`
    );
    expect(
      await t.stores.workflowRuns.markRunDataPruned({
        clientInstanceId,
        id: run.id,
        prunedAt: new Date().toISOString()
      })
    ).toBe(true);
    const repaired = await withTestSql(
      (
        sql
      ) => sql`select (select count(*)::int from conversation_attachments where conversation_id = ${pruned}) as attachments,
        (select count(*)::int from managed_artifacts where conversation_id = ${pruned}) as artifacts,
        (select count(*)::int from managed_files where object_key like ${`documents/${pruned}/%`}) as files`
    );
    expect(repaired).toEqual([{ attachments: 0, artifacts: 0, files: 0 }]);
  });
});
