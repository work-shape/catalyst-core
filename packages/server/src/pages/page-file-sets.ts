import { sha256Hex as sha256 } from "@work-shape/catalyst-core/sha256";
import {
  AppError,
  createFileSetId,
  fileSetContentType,
  fileSetFileObjectKey,
  fileSetObjectPrefix,
  normalizePageName,
  pageObjectPrefix,
  pageRefusal,
  readObjectBytes,
  requireFileSetWithinLimits,
  type ConversationId,
  type FileSet,
  type FileSetFile,
  type FileSetId,
  type FileSetOwner,
  type JsonObject,
  type NewFileSet,
  type ObjectStorage,
  type Page,
  type PlatformStores,
  type UserId
} from "@work-shape/catalyst-core";
import { isHtmlContentType } from "./app-content";
import type { ChatServerOptions } from "../types";

// Storing, reading and removing file sets, of Pages and of assets whose revisions hold files.
// A file set is stored once, under an id made for it, and nothing in this file writes to a
// stored one again.

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
  /** Stops the upload between two files. Nothing is stored then. */
  signal?: AbortSignal;
}

/**
 * Stores the row of the file set whose bytes are in the object store. A caller that must write
 * something else with the row, or not at all, hands in a function that runs `create` inside a
 * transaction of its own; when that function throws, no row exists and the bytes are removed.
 */
export type CommitPageFileSet = (
  create: (stores: Pick<PlatformStores, "pages">) => Promise<FileSet>,
  page: Page
) => Promise<FileSet>;

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
  input: StorePageFileSetInput,
  commit: CommitPageFileSet = (create) => create(options.stores)
): Promise<{ page: Page; fileSet: FileSet }> {
  const { objects } = requirePages(options);
  const name = normalizePageName(input.pageName);
  if (input.kitVersion.trim() === "") {
    throw new AppError("VALIDATION_FAILED", "A file set names the kit version it was built with");
  }
  const parts = requireStorableFileSet(input);
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
  const owner: FileSetOwner = { kind: "page", id: page.id };
  const prefix = fileSetObjectPrefix(owner, fileSetId);
  try {
    await writeFileSetObjects(objects, owner, fileSetId, parts, input.signal);
    input.signal?.throwIfAborted();
    const fileSet = await commit(
      (stores) =>
        stores.pages.createPageFileSet({
          clientInstanceId: options.clientInstanceId,
          pageId: page.id,
          fileSet: newFileSet(fileSetId, input, createdAt)
        }),
      page
    );
    return { page, fileSet };
  } catch (error) {
    // No row names these objects. A failure to remove them leaves bytes nothing reads, below
    // the Page's prefix, which the conversation's cleanup removes.
    await objects.deletePrefix(prefix).catch(() => undefined);
    // A Page this call made has no revision now, and a Page without one is none.
    if (Date.parse(page.createdAt) === Date.parse(createdAt)) {
      await removePageWithoutFileSets(options, page).catch(() => undefined);
    }
    throw error;
  }
}

type FileSetPart = { part: "src" | "dist"; file: PageFileInput };

type FileSetContent = { limits?: { files: number; fileBytes: number; treeBytes: number } } & Pick<
  StorePageFileSetInput,
  "kitVersion" | "manifest" | "sourceFiles" | "builtFiles" | "createdByUserId"
>;

/**
 * The files of a file set as they are stored, once they hold: within the limits of a file
 * set, and no built file with a shadow tree in its markup.
 */
function requireStorableFileSet(
  input: Pick<FileSetContent, "sourceFiles" | "builtFiles" | "limits">
): FileSetPart[] {
  const parts: FileSetPart[] = [
    ...input.sourceFiles.map((file) => ({ part: "src" as const, file })),
    ...input.builtFiles.map((file) => ({ part: "dist" as const, file }))
  ];
  requireFileSetWithinLimits(
    parts.map(({ part, file }) => ({ part, path: file.path, bytes: file.bytes.byteLength })),
    input.limits
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
  return parts;
}

/** Writes the objects of a file set below the prefix of its owner, a few at a time. */
export async function writeFileSetObjects(
  objects: ObjectStorage,
  owner: FileSetOwner,
  fileSetId: FileSetId,
  parts: readonly FileSetPart[],
  signal?: AbortSignal
): Promise<void> {
  const pending = [...parts];
  await Promise.all(
    Array.from({ length: FILE_SET_WRITE_CONCURRENCY }, async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        signal?.throwIfAborted();
        await objects.put(
          fileSetFileObjectKey(owner, fileSetId, next.part, next.file.path),
          next.file.bytes,
          { contentType: fileSetContentType(next.file.path) }
        );
      }
    })
  );
}

function newFileSet(fileSetId: FileSetId, input: FileSetContent, createdAt: string): NewFileSet {
  return {
    id: fileSetId,
    kitVersion: input.kitVersion,
    manifest: input.manifest,
    sourceFiles: input.sourceFiles.map(fileSetIndexEntry),
    builtFiles: input.builtFiles.map(fileSetIndexEntry),
    ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
    createdAt
  };
}

export interface StoreAssetFileSetInput extends FileSetContent {
  /** The id of the asset's row. The row need not exist yet. */
  assetId: string;
  /** Made by the caller, which may have written the source files below it already. */
  fileSetId: FileSetId;
  /** The parts whose bytes this call writes. A part left out lies in the store already. */
  writes: readonly ("src" | "dist")[];
  signal?: AbortSignal;
}

/** As `CommitPageFileSet`, for the file set of an asset. */
export type CommitAssetFileSet = (
  create: (stores: Pick<PlatformStores, "pages">) => Promise<FileSet>
) => Promise<FileSet>;

/**
 * Stores one file set of an asset: the bytes first, then the row that names them. It removes
 * nothing when it fails: the caller made the id, owns the prefix and removes it.
 */
export async function storeAssetFileSet(
  options: PagesContext,
  input: StoreAssetFileSetInput,
  commit: CommitAssetFileSet = (create) => create(options.stores)
): Promise<FileSet> {
  const { objects } = requirePages(options);
  if (input.kitVersion.trim() === "") {
    throw new AppError("VALIDATION_FAILED", "A file set names the kit version it was built with");
  }
  const parts = requireStorableFileSet(input);
  await writeFileSetObjects(
    objects,
    { kind: "asset", id: input.assetId },
    input.fileSetId,
    parts.filter(({ part }) => input.writes.includes(part)),
    input.signal
  );
  input.signal?.throwIfAborted();
  const createdAt = new Date().toISOString();
  return commit((stores) =>
    stores.pages.createAssetFileSet({
      clientInstanceId: options.clientInstanceId,
      assetId: input.assetId,
      fileSet: newFileSet(input.fileSetId, input, createdAt)
    })
  );
}

async function removePageWithoutFileSets(options: PagesContext, page: Page): Promise<void> {
  const address = { clientInstanceId: options.clientInstanceId, pageId: page.id };
  const fileSets = await options.stores.pages.listPageFileSets(address);
  if (fileSets.length === 0) {
    await options.stores.pages.deletePage(address);
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

/** One file as the row of its file set names it. */
function fileSetIndexEntry(file: PageFileInput): FileSetFile {
  return {
    path: file.path,
    sha256: sha256(file.bytes),
    bytes: file.bytes.byteLength,
    contentType: fileSetContentType(file.path)
  };
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
    fileSetFileObjectKey(fileSet.owner, fileSet.id, part, file.path)
  );
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new AppError("INTERNAL", "A stored file does not match its file set", {
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
