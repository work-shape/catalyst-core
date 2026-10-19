import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import {
  AppError,
  auditActorFromIdentity,
  createPlatformId,
  enqueueKnowledgeIndex,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_ADD_FILES_MAX_COUNT,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_OPERATION_PREFIX,
  knowledgeDocumentFormatOf,
  type AuthenticatedIdentity,
  type KnowledgeDocumentFormat,
  type KnowledgeDocumentInput,
  type KnowledgeFileRef,
  type KnowledgeFiles,
  type ManagedFileOwner,
  type KnowledgeBaseTarget,
  type OpenedKnowledgeFile,
  type OwnedManagedFile,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationUpload,
  type OperationResource
} from "@work-shape/catalyst-core";
import { knowledgeLimitError } from "./builtin/documents";
import { knowledgeTargetOf, type KnowledgeBaseDefinition } from "./definition";
import {
  enqueueKnowledgeFileCleanup,
  KNOWLEDGE_ADD_FILES_TIMEOUT_MS,
  removeUnusedKnowledgeCopies
} from "./file-cleanup";
import type { KnowledgeRuntime } from "./runtime";

// `knowledge.<id>.add_files`: a holder of `knowledge_base.write` adds files they can open to a
// Knowledge Base that keeps documents. Each is copied into a Managed File the Knowledge Base
// owns, so it follows the Knowledge Base's retention and not the Conversation's it came from:
// that Conversation's expiry removes its own copy and leaves this one (spec check 66). The
// documents' rows go into the Knowledge Base's store; once it is indexed every user of the
// published Knowledge Base finds them, without a publish (open question 2, option (a)).
//
// A person may also send one file from their device with the call (`knowledge_bases.upload_file`):
// the input then names it by `uploadFingerprint`: the checksum and size of its bytes and a
// checksum of its name and media type, and the bytes ride the live call (`runtime.upload`),
// never its input or its run. So the same idempotency key sent again with other bytes, or the
// same bytes under another name or type, is a reused key, not a replay. No name is recorded. The file takes the same
// checks, copy, audit and cleanup. A call without the live file, or with other bytes than its
// input names, is refused; a call with a live file is never held for an approval (run-operation).
//
// Sensitive data. The run keeps the input (Conversation and file ids) as a hash and the output
// (document and file ids, a count and bytes); the audit event `knowledge_base.files_added` holds
// the Knowledge Base, the file ids, the count and the bytes. Neither holds a file name, because
// the names of personal documents name people, nor anything a file holds. A refusal names the
// file by its id.

/**
 * Where a copy of a Knowledge Base is kept in the store of files: an object of its own, never
 * shared, so that removing one copy cannot take the bytes of another. Every object of one
 * Knowledge Base lies under one prefix.
 */
function knowledgeObjectKey(assetId: string): string {
  return `knowledge-bases/${assetId}/${createPlatformId("kbobj")}`;
}

const idSchema = z.string().min(1).max(200);

const addFilesInputSchema = z.union([
  z.strictObject({
    files: z
      .array(z.strictObject({ conversationId: idSchema, fileId: idSchema }))
      .min(1)
      .max(KNOWLEDGE_ADD_FILES_MAX_COUNT, {
        error: `A call adds at most ${KNOWLEDGE_ADD_FILES_MAX_COUNT} files (KNOWLEDGE_ADD_FILES_MAX_COUNT). Send the rest in another call.`
      })
  }),
  /** The one file the caller sent with the call: `knowledge_bases.upload_file`. */
  z.strictObject({
    upload: z.strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().min(0),
      /** The SHA-256 of the file's name and media type: it tells them apart, never says them. */
      metadataSha256: z.string().regex(/^[0-9a-f]{64}$/)
    })
  })
]);

const addFilesOutputSchema = z.object({
  /** Each document added, with the Managed File the Knowledge Base now owns. In input order. */
  documents: z.array(z.object({ id: z.string(), fileId: z.string() })),
  count: z.number().int(),
  bytes: z.number().int()
});

/** The title a document starts with: its file name without the extension. */
function titleOf(filename: string): string {
  const extension = extname(filename);
  return (extension ? filename.slice(0, -extension.length) : filename) || filename;
}

function actorUserId(actor: AuthenticatedIdentity): string {
  return isAuthenticatedServicePrincipal(actor) ? actor.id : getSubjectUserId(actor);
}

/** A file the caller named that it may not open, or that does not exist: the same answer. */
function fileNotAvailable(ref: KnowledgeFileRef): AppError {
  return new AppError(
    "NOT_FOUND",
    `File '${ref.fileId}' is not available in Conversation '${ref.conversationId}'.`,
    { reason: "knowledge_file_not_available" },
    { exposeMessage: true }
  );
}

/** How the input names a file sent with the call. */
type UploadInput = { sha256: string; bytes: number; metadataSha256: string };

/**
 * How the input of `add_files` names a file sent with the call. The route that receives the
 * file and the operation that takes it both build it here, so the two cannot disagree.
 */
export function uploadFingerprint(
  upload: Pick<OperationUpload, "sha256" | "byteSize" | "filename" | "mimeType">
): UploadInput {
  return {
    sha256: upload.sha256,
    bytes: upload.byteSize,
    metadataSha256: createHash("sha256")
      .update(JSON.stringify([upload.filename, upload.mimeType ?? null]))
      .digest("hex")
  };
}

/** A file the call adds, opened and checked: `label` names it in a refusal, by id, never by name. */
interface OpenedFile {
  label: string;
  file: OpenedKnowledgeFile;
  format: KnowledgeDocumentFormat;
  /** The checksum the input names the bytes by, for a file sent with the call. */
  sha256?: string;
}

/**
 * Opens every named file and checks it against the limits before any is read or copied, so
 * that a refused call leaves nothing behind.
 */
async function openAll(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  actor: AuthenticatedIdentity,
  refs: readonly KnowledgeFileRef[]
): Promise<OpenedFile[]> {
  const opened = [];
  for (const ref of refs) {
    const file = await files.open(actor, ref);
    if (!file) throw fileNotAvailable(ref);
    opened.push(checked(runtime, `File '${ref.fileId}'`, file));
  }
  return opened;
}

/** The file sent with the call, checked as a named one is. */
function openUpload(
  runtime: KnowledgeRuntime,
  context: OperationExecutionContext,
  named: UploadInput
): OpenedFile[] {
  const { upload } = context.runtime;
  const sent = upload && uploadFingerprint(upload);
  if (
    !upload ||
    !sent ||
    sent.sha256 !== named.sha256 ||
    sent.bytes !== named.bytes ||
    sent.metadataSha256 !== named.metadataSha256
  ) {
    throw uploadMissing();
  }
  return [{ ...checked(runtime, "The uploaded file", upload), sha256: named.sha256 }];
}

function uploadMissing(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    "No file with the checksum and size the input names was sent with this call. Upload a file through the Knowledge Base's uploads route, or name files of a Conversation in 'files'.",
    { reason: "knowledge_upload_missing" },
    { exposeMessage: true }
  );
}

/** Checks one file's format and size against what this instance's Knowledge Bases take. */
function checked(runtime: KnowledgeRuntime, label: string, file: OpenedKnowledgeFile): OpenedFile {
  const format = knowledgeDocumentFormatOf(file);
  if (!format) {
    throw knowledgeLimitError(
      "knowledge_file_format_unsupported",
      `${label} is in no format a Knowledge Base takes: PDF, DOCX, TXT or Markdown.`
    );
  }
  if (!runtime.documentFormats.includes(format)) {
    throw knowledgeLimitError(
      "knowledge_file_format_unavailable",
      `${label} is a ${format.toUpperCase()} file, and this instance reads no ${format.toUpperCase()}: that needs its document processing. It takes ${runtime.documentFormats.map((each) => each.toUpperCase()).join(", ")}.`
    );
  }
  if (file.byteSize > KNOWLEDGE_FILE_MAX_BYTES) throw tooLarge(label);
  return { label, file, format };
}

function tooLarge(label: string): AppError {
  return knowledgeLimitError(
    "knowledge_file_too_large",
    `${label} is larger than a Knowledge Base takes: ${KNOWLEDGE_FILE_MAX_BYTES} bytes (KNOWLEDGE_FILE_MAX_BYTES).`
  );
}

/**
 * Removes what a refused or failed call copied, except a copy a document names: a write that
 * committed and then failed to answer still added its documents. Where this fails too, the
 * job the call queued removes them.
 */
async function removeCopiesOfFailedCall(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  target: KnowledgeBaseTarget,
  copies: readonly OwnedManagedFile[]
): Promise<void> {
  if (target.backend !== "builtin" || copies.length === 0) return;
  try {
    await removeUnusedKnowledgeCopies(runtime, files, target, copies);
  } catch (error) {
    runtime.logger.warn(
      { error, knowledgeBaseId: target.assetId, fileCount: copies.length },
      "Removing the copies of a refused add_files call failed; its cleanup job removes them"
    );
  }
}

/** The Knowledge Base a call adds to: its published definition, asset and resource. */
interface AddFilesTarget {
  name: string;
  assetId: string;
  definition: KnowledgeBaseDefinition;
  resource: OperationResource;
}

export function addFilesOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: AddFilesTarget
): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.name}.add_files`,
    effect: "changing",
    // Removing a document takes it back.
    changeClass: "reversible",
    action: KNOWLEDGE_BASE_ACTIONS.write,
    scope: "data_store_rows:write",
    auth: "principal",
    inputSchema: addFilesInputSchema,
    outputSchema: addFilesOutputSchema,
    resource: () => ({ ...knowledgeBase.resource, title: knowledgeBase.definition.title }),
    module: "knowledge",
    timeoutMs: KNOWLEDGE_ADD_FILES_TIMEOUT_MS,
    async execute(input, context) {
      const parsed = addFilesInputSchema.parse(input);
      return addFiles(runtime, knowledgeBase, "files" in parsed ? parsed.files : parsed, context);
    }
  };
}

async function addFiles(
  runtime: KnowledgeRuntime,
  knowledgeBase: AddFilesTarget,
  refs: readonly KnowledgeFileRef[] | { upload: UploadInput },
  context: OperationExecutionContext
): Promise<z.infer<typeof addFilesOutputSchema>> {
  const { files } = runtime;
  if (!files) {
    throw new AppError(
      "CONFLICT",
      "This instance keeps no files: its release config names no 'infrastructure.objectStorage.files'.",
      { reason: "knowledge_files_unavailable" },
      { exposeMessage: true }
    );
  }
  const { signal } = context.runtime;
  const target = knowledgeTargetOf(knowledgeBase.definition, knowledgeBase.assetId);
  const check = await runtime.backend.check(target, signal);
  if (check.status !== "ok") {
    throw new AppError(
      "CONFLICT",
      check.problem ?? "The Knowledge Base cannot take files now.",
      { reason: "knowledge_store_not_ready" },
      { exposeMessage: true }
    );
  }
  const opened =
    "upload" in refs
      ? openUpload(runtime, context, refs.upload)
      : await openAll(runtime, files, context.actor, refs);
  // Queued before anything is copied: a process that ends in the middle of the call leaves its
  // copies to this job.
  if (target.backend === "builtin") await enqueueKnowledgeFileCleanup(runtime, target);
  const owner: ManagedFileOwner = { kind: "knowledge_base", id: knowledgeBase.assetId };
  const addedBy = actorUserId(context.actor);
  const documents: KnowledgeDocumentInput[] = [];
  const copies: OwnedManagedFile[] = [];
  let bytesAdded = 0;
  try {
    for (const { label, file, format, sha256 } of opened) {
      const bytes = await file.read();
      bytesAdded += bytes.byteLength;
      if (bytes.byteLength > KNOWLEDGE_FILE_MAX_BYTES) throw tooLarge(label);
      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== undefined && sha256 !== contentSha256) throw uploadMissing();
      // The row first: an object is never stored without a row that leads to it.
      const copy = await runtime.stores.files.createManagedFile({
        clientInstanceId: runtime.clientInstanceId,
        ownerUserId: addedBy,
        owner,
        filename: file.filename,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        byteSize: bytes.byteLength,
        checksum: contentSha256,
        objectKey: knowledgeObjectKey(knowledgeBase.assetId)
      });
      copies.push({ id: copy.id, objectKey: copy.objectKey, deleted: false });
      await files.objects.put(
        copy.objectKey,
        bytes,
        file.mimeType ? { contentType: file.mimeType } : {}
      );
      documents.push({
        id: createPlatformId("kbdoc"),
        fileId: copy.id,
        contentSha256,
        format,
        title: titleOf(file.filename),
        fileName: file.filename,
        addedBy
      });
    }
    await runtime.backend.addDocuments(
      target,
      { documents, maxDocuments: runtime.maxDocuments },
      signal
    );
  } catch (error) {
    await removeCopiesOfFailedCall(runtime, files, target, copies);
    throw error;
  }
  if (target.backend === "builtin") {
    await queueIndexJobs(runtime, knowledgeBase.assetId, documents, context.runId);
  }
  const fileIds = copies.map((copy) => copy.id);
  await context.audit.record({
    type: "knowledge_base.files_added",
    status: "success",
    actor: auditActorFromIdentity(context.actor),
    subject: knowledgeBase.assetId,
    correlationId: context.correlationId,
    metadata: {
      knowledgeBase: knowledgeBase.name,
      fileIds,
      count: fileIds.length,
      bytes: bytesAdded
    }
  });
  return {
    documents: documents.map(({ id, fileId }) => ({ id, fileId })),
    count: documents.length,
    bytes: bytesAdded
  };
}

/**
 * Queues the index job of each content the call added. The documents are added already, so a
 * failure here is logged and not the call's: their contents stay `pending` until Retry.
 */
async function queueIndexJobs(
  runtime: KnowledgeRuntime,
  knowledgeBaseId: string,
  documents: readonly KnowledgeDocumentInput[],
  operationRunId: string
): Promise<void> {
  const contents = new Map(documents.map((document) => [document.contentSha256, document.fileId]));
  try {
    for (const [contentSha256, fileId] of contents) {
      await enqueueKnowledgeIndex(
        runtime.stores.jobs,
        { knowledgeBaseId, contentSha256, fileId, operationRunId },
        { clientInstanceId: runtime.clientInstanceId, dedupe: true }
      );
    }
  } catch (error) {
    runtime.logger.warn(
      { error, knowledgeBaseId, contentCount: contents.size },
      "Queueing the index jobs of added documents failed; Retry queues them"
    );
  }
}
