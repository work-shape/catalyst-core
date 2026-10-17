import { createHash } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import {
  AppError,
  auditActorFromIdentity,
  createPlatformId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_OPERATION_PREFIX,
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
// Sensitive data. The run keeps the input (Conversation and file ids) as a hash and the output
// (document and file ids, a count and bytes); the audit event `knowledge_base.files_added` holds
// the Knowledge Base, the file ids, the count and the bytes. Neither holds a file name, because
// the names of personal documents name people, nor anything a file holds. A refusal names the
// file by its id.

/**
 * How many files one call adds at most. It bounds what one call reads and copies; a caller with
 * more sends several calls. A larger list is refused with this limit named.
 */
const KNOWLEDGE_ADD_FILES_MAX_COUNT = 20;

/**
 * Where a copy of a Knowledge Base is kept in the store of files: an object of its own, never
 * shared, so that removing one copy cannot take the bytes of another. Every object of one
 * Knowledge Base lies under one prefix.
 */
function knowledgeObjectKey(assetId: string): string {
  return `knowledge-bases/${assetId}/${createPlatformId("kbobj")}`;
}

const idSchema = z.string().min(1).max(200);

const addFilesInputSchema = z.strictObject({
  files: z
    .array(z.strictObject({ conversationId: idSchema, fileId: idSchema }))
    .min(1)
    .max(KNOWLEDGE_ADD_FILES_MAX_COUNT, {
      error: `A call adds at most ${KNOWLEDGE_ADD_FILES_MAX_COUNT} files (KNOWLEDGE_ADD_FILES_MAX_COUNT). Send the rest in another call.`
    })
});

const addFilesOutputSchema = z.object({
  /** Each document added, with the Managed File the Knowledge Base now owns. In input order. */
  documents: z.array(z.object({ id: z.string(), fileId: z.string() })),
  count: z.number().int(),
  bytes: z.number().int()
});

/** The format of a file by its name, then by its media type. Nothing for one a Knowledge Base does not take. */
function documentFormatOf(file: OpenedKnowledgeFile): KnowledgeDocumentFormat | undefined {
  switch (extname(file.filename).toLowerCase()) {
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
  }
  switch (file.mimeType?.split(";")[0]?.trim().toLowerCase()) {
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "markdown";
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
  }
  return undefined;
}

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

/**
 * Opens every named file and checks it against the limits before any is read or copied, so
 * that a refused call leaves nothing behind.
 */
async function openAll(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  actor: AuthenticatedIdentity,
  refs: readonly KnowledgeFileRef[]
): Promise<
  { ref: KnowledgeFileRef; file: OpenedKnowledgeFile; format: KnowledgeDocumentFormat }[]
> {
  const opened = [];
  for (const ref of refs) {
    const file = await files.open(actor, ref);
    if (!file) throw fileNotAvailable(ref);
    const format = documentFormatOf(file);
    if (!format) {
      throw knowledgeLimitError(
        "knowledge_file_format_unsupported",
        `File '${ref.fileId}' is in no format a Knowledge Base takes: PDF, DOCX, TXT or Markdown.`
      );
    }
    if (!runtime.documentFormats.includes(format)) {
      throw knowledgeLimitError(
        "knowledge_file_format_unavailable",
        `File '${ref.fileId}' is a ${format.toUpperCase()} file, and this instance reads no ${format.toUpperCase()}: that needs its document processing. It takes ${runtime.documentFormats.map((each) => each.toUpperCase()).join(", ")}.`
      );
    }
    if (file.byteSize > KNOWLEDGE_FILE_MAX_BYTES) throw tooLarge(ref);
    opened.push({ ref, file, format });
  }
  return opened;
}

function tooLarge(ref: KnowledgeFileRef): AppError {
  return knowledgeLimitError(
    "knowledge_file_too_large",
    `File '${ref.fileId}' is larger than a Knowledge Base takes: ${KNOWLEDGE_FILE_MAX_BYTES} bytes (KNOWLEDGE_FILE_MAX_BYTES).`
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
    resource: () => knowledgeBase.resource,
    module: "knowledge",
    timeoutMs: KNOWLEDGE_ADD_FILES_TIMEOUT_MS,
    async execute(input, context) {
      const { files: refs } = addFilesInputSchema.parse(input);
      return addFiles(runtime, knowledgeBase, refs, context);
    }
  };
}

async function addFiles(
  runtime: KnowledgeRuntime,
  knowledgeBase: AddFilesTarget,
  refs: readonly KnowledgeFileRef[],
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
  const opened = await openAll(runtime, files, context.actor, refs);
  // Queued before anything is copied: a process that ends in the middle of the call leaves its
  // copies to this job.
  if (target.backend === "builtin") await enqueueKnowledgeFileCleanup(runtime, target);
  const owner: ManagedFileOwner = { kind: "knowledge_base", id: knowledgeBase.assetId };
  const addedBy = actorUserId(context.actor);
  const documents: KnowledgeDocumentInput[] = [];
  const copies: OwnedManagedFile[] = [];
  let bytesAdded = 0;
  try {
    for (const { ref, file, format } of opened) {
      const bytes = await file.read();
      bytesAdded += bytes.byteLength;
      if (bytes.byteLength > KNOWLEDGE_FILE_MAX_BYTES) throw tooLarge(ref);
      const contentSha256 = createHash("sha256").update(bytes).digest("hex");
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
