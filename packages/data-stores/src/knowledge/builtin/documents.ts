import { z } from "zod";
import {
  AppError,
  asManagedFileId,
  type BuiltinKnowledgeTarget,
  type KnowledgeDocumentInput
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";
import { databaseFailureError } from "../../failures";
import { ownedStoreCheck } from "./owned-store";

// The rows of the documents a Knowledge Base on the built-in backend holds, written into the
// store it owns as the platform's role, which owns `catalyst_kb`. A document names the Managed
// File the Knowledge Base owns and its content; identical files share one content, which the
// index job extracts and chunks once. A new content waits as `pending` for that job.
//
// Who may make a file searchable. A holder of `knowledge_base.write` adds a document and every
// user of the published Knowledge Base finds it once it is indexed (open question 2, option
// (a)). Option (b), a release by a holder of `knowledge_base.publish`, would add a column
// `released_at` to `documents` in a store migration of a later release, set to `added_at` for
// every row already there, and a filter on it in search: no platform migration and no change
// to the Managed Files.

/** How long writing the rows of one call may take, waiting for another call's lock included. */
const KNOWLEDGE_DOCUMENTS_WRITE_TIMEOUT_MS = 30_000;

const countRow = z.object({ count: z.number().int() });

/**
 * The lock that writing documents takes, one write at a time per store, and that a cleanup
 * waits for before it reads which copies documents name. It conflicts with itself and lets
 * search read.
 */
const LOCK_DOCUMENTS = "lock table catalyst_kb.documents in share row exclusive mode";

/** Why documents were not written: the limit, or copies a cleanup removed first. */
type Refusal = { kind: "limit"; count: number } | { kind: "released" };

/**
 * Writes the rows of `documents` into the store of `target`, and of each content the store has
 * none of yet. One add at a time per store, so that the count of documents it checks against
 * `maxDocuments` is the count it writes on. A withdrawn document does not count.
 */
export async function addKnowledgeDocuments(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget,
  input: { documents: readonly KnowledgeDocumentInput[]; maxDocuments: number },
  signal?: AbortSignal
): Promise<void> {
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: target.assetId
  });
  const check = ownedStoreCheck(record);
  if (!record || check.problem !== undefined) {
    throw new AppError(
      "CONFLICT",
      check.problem ?? "The Knowledge Base has no store for its documents yet.",
      { reason: "knowledge_store_not_ready" },
      { exposeMessage: true }
    );
  }
  let refusal: Refusal | undefined;
  try {
    // A throw inside the change would reach the caller as the executor's own failure, so a
    // refusal comes back as a value and is thrown after it.
    refusal = await runtime.server.executor.change(
      {
        ...runtime.server.asPlatform(record.location.database),
        timeoutMs: KNOWLEDGE_DOCUMENTS_WRITE_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      },
      async (sql): Promise<Refusal | undefined> => {
        await sql.script(LOCK_DOCUMENTS);
        // Under the lock no cleanup removes a copy: one that removed any before stays removed,
        // and its documents are not written.
        if (!(await copiesHeld(runtime, target, input.documents))) return { kind: "released" };
        const [held] = z
          .array(countRow)
          .parse(
            await sql.run(
              "select count(*)::pg_catalog.int4 as count from catalyst_kb.documents where withdrawn_at is null"
            )
          );
        const count = held?.count ?? 0;
        if (count + input.documents.length > input.maxDocuments) return { kind: "limit", count };
        for (const document of input.documents) {
          await sql.run(
            `insert into catalyst_kb.contents (sha256, format)
             values ($1::pg_catalog.text, $2::pg_catalog.text)
             on conflict (sha256) do nothing`,
            [document.contentSha256, document.format]
          );
          await sql.run(
            `insert into catalyst_kb.documents
               (id, managed_file_id, content_sha256, title, file_name, added_by)
             values ($1::pg_catalog.text, $2::pg_catalog.text, $3::pg_catalog.text,
               $4::pg_catalog.text, $5::pg_catalog.text, $6::pg_catalog.text)`,
            [
              document.id,
              document.fileId,
              document.contentSha256,
              document.title,
              document.fileName,
              document.addedBy ?? null
            ]
          );
        }
        return undefined;
      }
    );
  } catch (error) {
    throw databaseFailureError(error, "Adding the documents");
  }
  if (refusal?.kind === "released") {
    throw new AppError(
      "CONFLICT",
      `The copies of these files were removed before Knowledge Base '${target.name}' took them, because the call took too long. Add the files again.`,
      { reason: "knowledge_files_released" },
      { exposeMessage: true }
    );
  }
  if (refusal?.kind === "limit") {
    throw knowledgeLimitError(
      "knowledge_documents_limit",
      `Knowledge Base '${target.name}' holds ${refusal.count} documents, and a Knowledge Base holds at most ${input.maxDocuments} (knowledge.maxDocuments). Remove documents first, or ask the operator to raise the limit.`
    );
  }
}

const fileIdRow = z.object({ managed_file_id: z.string() });

/**
 * Which of `fileIds` a document in the store of `target` names, withdrawn or not, read under
 * the lock that writing documents takes: every write in progress has ended. None once the store
 * is gone with its Knowledge Base. A store that cannot be read throws.
 */
export async function knowledgeDocumentFileIds(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget,
  fileIds: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: target.assetId
  });
  if (!record || record.status === "retired") return [];
  try {
    return await runtime.server.executor.change(
      {
        ...runtime.server.asPlatform(record.location.database),
        timeoutMs: KNOWLEDGE_DOCUMENTS_WRITE_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      },
      async (sql) => {
        await sql.script(LOCK_DOCUMENTS);
        return z
          .array(fileIdRow)
          .parse(
            await sql.run(
              `select managed_file_id from catalyst_kb.documents
               where managed_file_id = any($1::pg_catalog.text[])`,
              [[...fileIds]]
            )
          )
          .map((row) => row.managed_file_id);
      }
    );
  } catch (error) {
    throw databaseFailureError(error, "Reading the documents");
  }
}

/** Whether every copy the documents name is still one the Knowledge Base owns, not removed. */
async function copiesHeld(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget,
  documents: readonly KnowledgeDocumentInput[]
): Promise<boolean> {
  for (const document of documents) {
    const copy = await runtime.stores.files.getManagedFile({
      clientInstanceId: runtime.clientInstanceId,
      fileId: asManagedFileId(document.fileId)
    });
    if (copy?.owner?.kind !== "knowledge_base" || copy.owner.id !== target.assetId) return false;
  }
  return true;
}

/** A refusal at a limit of what a Knowledge Base takes. `reason` is its stable code. */
export function knowledgeLimitError(reason: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason }, { exposeMessage: true });
}
