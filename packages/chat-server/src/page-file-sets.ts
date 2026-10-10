import { createHash } from "node:crypto";
import {
  AppError,
  createFileSetId,
  fileSetContentType,
  normalizePageName,
  pageFileObjectKey,
  pageFileSetObjectPrefix,
  pageObjectPrefix,
  pageRefusal,
  readObjectBytes,
  requireFileSetWithinLimits,
  type ConversationId,
  type FileSet,
  type FileSetFile,
  type JsonObject,
  type Page,
  type UserId
} from "@vivd-catalyst/core";
import { isHtmlContentType } from "./app-content";
import type { ChatServerOptions } from "./types";

// Storing, reading and removing the file sets of Pages. A file set is stored once, under an id
// made here, and nothing in this file writes to a stored one again.

type PagesContext = Pick<ChatServerOptions, "clientInstanceId" | "stores" | "pages">;

/** How many objects of one file set are written at a time. */
const FILE_SET_WRITE_CONCURRENCY = 8;

/** One file as a caller hands it over. Its type follows from its path. */
export interface PageFileInput {
  path: string;
  bytes: Uint8Array;
}

export interface StorePageFileSetInput {
  conversationId: ConversationId;
  /** The Page of this name in the conversation gets the file set; a new name is a new Page. */
  pageName: string;
  kitVersion: string;
  /** The manifest as the build validated it. */
  manifest: JsonObject;
  sourceFiles: readonly PageFileInput[];
  builtFiles: readonly PageFileInput[];
  createdByUserId?: UserId;
}

function requirePages(options: PagesContext): NonNullable<ChatServerOptions["pages"]> {
  if (!options.pages) {
    throw new AppError("INTERNAL", "Pages are not configured on this instance");
  }
  return options.pages;
}

/**
 * Stores one revision of a Page: the bytes first, then the row that names them, so a row never
 * names a file that is not there. Refuses a file set over a limit before anything is written.
 * What the build of a save hands over is stored as it is; this function runs none of it.
 */
export async function storePageFileSet(
  options: PagesContext,
  input: StorePageFileSetInput
): Promise<{ page: Page; fileSet: FileSet }> {
  const { objects } = requirePages(options);
  const name = normalizePageName(input.pageName);
  if (input.kitVersion.trim() === "") {
    throw new AppError("VALIDATION_FAILED", "A file set names the kit version it was built with");
  }
  const parts = [
    ...input.sourceFiles.map((file) => ({ part: "src" as const, file })),
    ...input.builtFiles.map((file) => ({ part: "dist" as const, file }))
  ];
  requireFileSetWithinLimits(
    parts.map(({ part, file }) => ({ part, path: file.path, bytes: file.bytes.byteLength }))
  );
  for (const file of input.builtFiles) {
    if (holdsDeclarativeShadowTree(file)) {
      throw pageRefusal(
        "file_set_invalid",
        `The file '${file.path}' declares a shadow tree in its markup ('shadowrootmode'). A Page attaches shadow trees with a script.`,
        { file: file.path }
      );
    }
  }
  const conversation = await options.stores.conversations.getConversation(
    options.clientInstanceId,
    input.conversationId
  );
  if (!conversation || conversation.status !== "active") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  const createdAt = new Date().toISOString();
  const page = await options.stores.pages.ensurePage({
    clientInstanceId: options.clientInstanceId,
    conversationId: input.conversationId,
    name,
    createdAt
  });
  const fileSetId = createFileSetId();
  const prefix = pageFileSetObjectPrefix(page.id, fileSetId);
  try {
    const pending = [...parts];
    await Promise.all(
      Array.from({ length: FILE_SET_WRITE_CONCURRENCY }, async () => {
        for (let next = pending.shift(); next; next = pending.shift()) {
          await objects.put(
            pageFileObjectKey(page.id, fileSetId, next.part, next.file.path),
            next.file.bytes,
            { contentType: fileSetContentType(next.file.path) }
          );
        }
      })
    );
    const fileSet = await options.stores.pages.createPageFileSet({
      clientInstanceId: options.clientInstanceId,
      pageId: page.id,
      fileSet: {
        id: fileSetId,
        kitVersion: input.kitVersion,
        manifest: input.manifest,
        sourceFiles: input.sourceFiles.map(indexEntry),
        builtFiles: input.builtFiles.map(indexEntry),
        ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
        createdAt
      }
    });
    return { page, fileSet };
  } catch (error) {
    // No row names these objects. A failure to remove them leaves bytes nothing reads, below
    // the Page's prefix, which the conversation's cleanup removes.
    await objects.deletePrefix(prefix).catch(() => undefined);
    throw error;
  }
}

/**
 * A shadow tree the parser attaches is one the Page's guard script never sees, and a closed one
 * can hold a link the guard cannot reach. The attribute cannot be spelled with a character
 * reference, so looking for its name in the text of the file finds every use, and a file that
 * only mentions it is refused too.
 */
function holdsDeclarativeShadowTree(file: PageFileInput): boolean {
  return (
    isHtmlContentType(fileSetContentType(file.path)) &&
    /shadowroot/iu.test(new TextDecoder().decode(file.bytes))
  );
}

function indexEntry(file: PageFileInput): FileSetFile {
  return {
    path: file.path,
    sha256: sha256(file.bytes),
    bytes: file.bytes.byteLength,
    contentType: fileSetContentType(file.path)
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes of one file of a file set, checked against the hash its row holds. A file that
 * does not match is not handed out: what is read is what was stored.
 */
export async function readFileSetFile(
  options: PagesContext,
  fileSet: FileSet,
  part: "src" | "dist",
  file: FileSetFile
): Promise<Uint8Array> {
  const { objects } = requirePages(options);
  const bytes = await readObjectBytes(
    objects,
    pageFileObjectKey(fileSet.owner.id, fileSet.id, part, file.path)
  );
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new AppError("INTERNAL", "A stored file of a Page does not match its file set", {
      fileSetId: fileSet.id
    });
  }
  return bytes;
}

/** The file a frame is given when its address names none. */
export function fileSetEntryPath(fileSet: FileSet): string {
  const { entry } = fileSet.manifest;
  return typeof entry === "string" && entry !== "" ? entry : "index.html";
}

/**
 * Removes the Pages of a conversation that is deleted or expired: the stored objects of each
 * Page first, then its rows, so a failure leaves the rows that lead to what is left. Safe to
 * repeat. It does not ask whether the module `apps` is on. An instance without the `files`
 * store can still hold the rows of a time it had one; then this fails instead of looking
 * clean, and the retention job tries again.
 */
export async function deleteConversationPages(
  options: PagesContext,
  conversationId: ConversationId
): Promise<void> {
  const pageIds = await options.stores.pages.listConversationPageIds({
    clientInstanceId: options.clientInstanceId,
    conversationId
  });
  if (pageIds.length === 0) {
    return;
  }
  const { objects } = requirePages(options);
  for (const pageId of pageIds) {
    await objects.deletePrefix(pageObjectPrefix(pageId));
    await options.stores.pages.deletePage({ clientInstanceId: options.clientInstanceId, pageId });
  }
}
