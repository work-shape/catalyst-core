import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_RUN_FILE_MAX_BYTES, type WorkflowRun } from "@work-shape/catalyst-core";
import { createWorkflowRunFiles, runFilesOwner } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
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
    now: () => new Date()
  });
  return { t, objects, files, run: await readRun(), readRun };
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
});
