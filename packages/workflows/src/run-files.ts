import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  asManagedFileId,
  readObjectBytes,
  WORKFLOW_RUN_FILE_MAX_BYTES,
  WORKFLOW_RUN_FILES_MAX_BYTES,
  isWorkflowRunEnded,
  type ClientInstanceId,
  type ConversationId,
  type ManagedFileOwner,
  type ManagedFileRecord,
  type ObjectStorage,
  type PlatformStores,
  type WorkflowFileReference,
  type WorkflowRun,
  type WorkflowRunId
} from "@work-shape/catalyst-core";
import { principalActor } from "./run-identity";
import { WorkflowStepFailure } from "./step-failure";

// The files of a Workflow run: documents a step took in, such as what a person sent with a
// form. Each is a Managed File the run owns, its bytes in the instance's files store below the
// run's own prefix, and step data names it by a reference, never by its bytes. The files go with
// the run's values; until then only the steps of the same run name them.

const DAY_MS = 86_400_000;
const PRUNE_BATCH = 200;

export const runFilesOwner = (runId: string): ManagedFileOwner => ({
  kind: "workflow_run",
  id: runId
});

const runFilesPrefix = (runId: string) => `workflow-runs/${runId}/files/`;

export interface WorkflowRunFiles {
  /** Keeps a file in a run that has not ended and answers its reference. */
  create(input: {
    run: WorkflowRun;
    filename: string;
    mimeType: string;
    content: Uint8Array;
  }): Promise<WorkflowFileReference>;
  /**
   * Refuses a step whose input names a file that is not the run's, or not as it is stored: a
   * step names only files its own run took in.
   */
  check(run: WorkflowRun, references: readonly WorkflowFileReference[]): Promise<void>;
  /**
   * A file of a run with its bytes, for the agent of a step that names it. `undefined` for a
   * file that is no run's or is gone.
   */
  read(fileId: string): Promise<{ file: ManagedFileRecord; bytes: Uint8Array } | undefined>;
  /**
   * Deletes the files of a run whose values are pruned, and what its run threads hold of the
   * copies its agents got. Answers whether nothing of them is left.
   */
  prune(runId: WorkflowRunId, signal?: AbortSignal): Promise<boolean>;
}

export function createWorkflowRunFiles(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  objects: ObjectStorage;
  /**
   * Removes what a run thread holds of its attachments: the copies of the run's files an agent
   * got and what was prepared from them. The attachment handlers own those objects.
   */
  releaseThread?(conversationId: ConversationId): Promise<void>;
  now(): Date;
}): WorkflowRunFiles {
  const { clientInstanceId, stores, objects, now } = options;

  /**
   * Without attachment handlers, the copies in a run thread have nobody else to remove them: as
   * a handler alone would, their bytes and what was prepared from them are deleted from the
   * files store, the one store the engine knows, and their records are marked deleted, so they
   * go with the run's values. A file another conversation still names stays.
   */
  async function releaseWithoutHandler(conversationId: ConversationId) {
    const deletion = await stores.files.listConversationManagedObjectsForDeletion({
      clientInstanceId,
      conversationId
    });
    for (const objectKey of [...deletion.fileObjectKeys, ...deletion.artifactObjectKeys])
      await objects.delete(objectKey);
    await stores.files.markConversationManagedObjectsDeleted({
      clientInstanceId,
      conversationId,
      deletedAt: now().toISOString()
    });
  }

  return {
    async create({ run, filename, mimeType, content }) {
      if (isWorkflowRunEnded(run.status)) {
        throw new AppError("CONFLICT", "The Workflow run has ended, so it keeps no new file", {
          reason: "run_ended"
        });
      }
      if (content.byteLength === 0 || content.byteLength > WORKFLOW_RUN_FILE_MAX_BYTES) {
        throw new AppError(
          "VALIDATION_FAILED",
          `A file of a run has 1 to ${WORKFLOW_RUN_FILE_MAX_BYTES} bytes`,
          { reason: "file_too_large" }
        );
      }
      const owner = runFilesOwner(run.id);
      const held = await stores.files.ownedManagedFileBytes({ clientInstanceId, owner });
      if (held + content.byteLength > WORKFLOW_RUN_FILES_MAX_BYTES) {
        throw new AppError(
          "CONFLICT",
          `The files of one run hold at most ${WORKFLOW_RUN_FILES_MAX_BYTES} bytes`,
          { reason: "run_files_full" }
        );
      }
      const objectKey = `${runFilesPrefix(run.id)}${randomUUID()}`;
      // The bytes first: a row never names an object that is not there. An object whose row
      // was never written lies below the run's prefix and goes with the run's files.
      await objects.put(objectKey, content, { contentType: mimeType });
      const sha256 = createHash("sha256").update(content).digest("hex");
      const file = await stores.files.createManagedFile({
        clientInstanceId,
        // A test run's files are its tester's, as its agent acts for the tester.
        ownerUserId:
          run.mode === "test" && run.startedBy.kind === "user"
            ? run.startedBy.id
            : run.principal.id,
        owner,
        filename,
        mimeType,
        byteSize: content.byteLength,
        checksum: sha256,
        objectKey
      });
      // Size, digest and type only: a file's name never goes into the audit.
      await stores.audit.appendAuditEvent({
        clientInstanceId,
        type: "workflow_run.file_kept",
        status: "success",
        actor: principalActor(run),
        subject: run.id,
        correlationId: run.correlationId,
        metadata: { runId: run.id, fileId: file.id, bytes: content.byteLength, sha256, mimeType }
      });
      return { $file: file.id, name: filename, mimeType, bytes: content.byteLength };
    },

    async check(run, references) {
      if (references.length === 0) return;
      const files = await stores.files.listOwnedManagedFilesById({
        clientInstanceId,
        owner: runFilesOwner(run.id),
        fileIds: references.map((reference) => reference.$file)
      });
      const byId = new Map<string, (typeof files)[number]>(files.map((file) => [file.id, file]));
      for (const reference of references) {
        const file = byId.get(reference.$file);
        if (
          !file ||
          file.status !== "available" ||
          file.byteSize !== reference.bytes ||
          file.mimeType !== reference.mimeType
        ) {
          throw new WorkflowStepFailure(
            "file_reference_invalid",
            "The input names a file that is not one of this run's"
          );
        }
      }
    },

    async read(fileId) {
      const file = await stores.files.getManagedFile({
        clientInstanceId,
        fileId: asManagedFileId(fileId)
      });
      if (!file || file.status !== "available" || file.owner?.kind !== "workflow_run") {
        return undefined;
      }
      return { file, bytes: await readObjectBytes(objects, file.objectKey) };
    },

    async prune(runId, signal) {
      const owner = runFilesOwner(runId);
      for (const conversationId of await stores.childAgentRuns.listWorkflowRunThreadIds({
        clientInstanceId,
        runId
      })) {
        if (signal?.aborted) return false;
        if (options.releaseThread) await options.releaseThread(conversationId);
        else await releaseWithoutHandler(conversationId);
      }
      await objects.deletePrefix(runFilesPrefix(runId));
      for (;;) {
        if (signal?.aborted) return false;
        const files = await stores.files.listOwnedManagedFiles({
          clientInstanceId,
          owner,
          createdAfter: new Date(0).toISOString(),
          createdBefore: new Date(now().getTime() + DAY_MS).toISOString(),
          limit: PRUNE_BATCH
        });
        if (files.length === 0) return true;
        // An object outside the run's prefix, which no file of this release has, goes too.
        for (const file of files) await objects.delete(file.objectKey);
        await stores.files.deleteOwnedManagedFiles({
          clientInstanceId,
          owner,
          fileIds: files.map((file) => file.id)
        });
      }
    }
  };
}
