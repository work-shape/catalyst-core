import type { AppAvailability } from "./app-audience";
import { AppError } from "./errors";
import {
  createPlatformId,
  type Brand,
  type ClientInstanceId,
  type ConversationId,
  type UserId
} from "./ids";
import type { JsonObject } from "./json";

// A Page is a folder of files a conversation owns. Each save is a file set: the source files,
// the built files, the validated manifest and the kit version, stored once and never changed.

export type PageId = Brand<string, "PageId">;
export type FileSetId = Brand<string, "FileSetId">;

export function createPageId(): PageId {
  return createPlatformId<"PageId">("page");
}

export function createFileSetId(): FileSetId {
  return createPlatformId<"FileSetId">("fset");
}

/** One build of a Page: what a save asked for and how it ended. */
export type PageBuildId = Brand<string, "PageBuildId">;

export function createPageBuildId(): PageBuildId {
  return createPlatformId<"PageBuildId">("pbuild");
}

/** Whether a string from outside, such as a job payload, has the form of a build id. */
export function isPageBuildId(value: string): value is PageBuildId {
  return /^pbuild_[0-9a-f-]{36}$/u.test(value);
}

const PAGE_ID = /^page_[0-9a-f-]{36}$/u;
const FILE_SET_ID = /^fset_[0-9a-f-]{36}$/u;

/** Whether a string from outside, such as a path segment, has the form of a Page id. */
export function isPageId(value: string): value is PageId {
  return PAGE_ID.test(value);
}

/** Whether a string from outside, such as a path segment, has the form of a file set id. */
export function isFileSetId(value: string): value is FileSetId {
  return FILE_SET_ID.test(value);
}

/**
 * The limits of one file set. They protect the object store and a browser from one save that
 * is far larger than any Page a person builds in a conversation. A save over one of them is
 * refused with `file_set_too_large` and the name of the limit.
 */
export const FILE_SET_MAX_FILES = 500;
export const FILE_SET_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * The input field of a write of an App from a Page that names the Page revision it copies. A
 * call held for an approval keeps the revision its guardrails read in it (`heldInputKeys`).
 */
export const PAGE_FILE_SET_HELD_KEY = "fileSetId";

export const FILE_SET_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
/** The longest path of a file in a file set, in characters. */
export const FILE_SET_MAX_PATH_CHARS = 512;
/**
 * How many file sets one Page keeps. A Page gets one per agent turn that saves it; the save
 * after this many is refused with `page_revision_limit`, and the Page is continued under a new
 * name.
 */
export const PAGE_MAX_FILE_SETS = 1000;
/** How many Pages one conversation holds. The next new name is refused with `page_limit`. */
export const CONVERSATION_MAX_PAGES = 200;
/** The longest name of a Page, in characters. */
export const PAGE_NAME_MAX_CHARS = 120;

/**
 * The folder name the platform keeps for its own files beside a Page's. No file of a file set
 * may lie below a folder of this name, at any depth.
 */
export const FILE_SET_RESERVED_SEGMENT = "__catalyst";

/**
 * How many decoded bytes of files one `assets.put` carries. A write hands over the whole
 * source set in one JSON call, so this bounds the call beside the limits of a file set.
 */
export const ASSET_PUT_FILES_MAX_BYTES = 8 * 1024 * 1024;

/**
 * How many bytes of file contents one `assets.get` answers. A source set above it, such as one
 * copied from a large Page, is answered as its index without contents.
 */
export const ASSET_GET_FILES_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Who a file set belongs to: a Page of a conversation, or an asset whose revisions hold files,
 * named by the id of its row.
 */
export type FileSetOwner = { kind: "page"; id: PageId } | { kind: "asset"; id: string };

/** One file of a file set as its row holds it. The bytes are in the object store. */
export interface FileSetFile {
  /** Relative, with `/` between segments. */
  path: string;
  /** Lower-case hex. What is served is checked against it. */
  sha256: string;
  bytes: number;
  contentType: string;
}

export interface Page {
  id: PageId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  /** Unique in its conversation. */
  name: string;
  createdAt: string;
}

/** A file set without its file index: what a history lists. */
export interface FileSetSummary {
  id: FileSetId;
  owner: FileSetOwner;
  /** Counts up from 1 per owner. */
  number: number;
  kitVersion: string;
  sourceFileCount: number;
  builtFileCount: number;
  totalBytes: number;
  createdByUserId?: UserId;
  createdAt: string;
}

export interface FileSet extends FileSetSummary {
  clientInstanceId: ClientInstanceId;
  /** The validated manifest, as the build wrote it. */
  manifest: JsonObject;
  sourceFiles: FileSetFile[];
  builtFiles: FileSetFile[];
}

/** The asset a served file set belongs to, with what decides who is served it. */
export interface ServedFileSetAsset {
  appAvailability?: AppAvailability;
  id: string;
  kind: string;
  name: string;
  workspaceId?: string;
  activeRevisionId: string;
  publishedRevisionId?: string;
  /** The file set of the published revision, which may be another than this one. */
  publishedFileSetId?: FileSetId;
  /** The revisions of the asset that hold this file set. */
  revisionIds: string[];
}

/**
 * A file set as the content route reads it: with the conversation its Page belongs to, or
 * with the asset that owns it.
 */
export type ServedFileSet = FileSet &
  (
    | { conversationId: ConversationId; asset?: undefined }
    | { asset: ServedFileSetAsset; conversationId?: undefined }
  );

/** What a caller hands over to store a file set. The store assigns the number. */
export interface NewFileSet {
  id: FileSetId;
  kitVersion: string;
  manifest: JsonObject;
  sourceFiles: FileSetFile[];
  builtFiles: FileSetFile[];
  createdByUserId?: UserId;
  createdAt: string;
}

/** One file of the folder a save snapshots: where its bytes are and what they hash to. */
export interface PageBuildSourceFile {
  /** Relative to the Page's folder. */
  path: string;
  /** The object of the `workspaces` store that holds the bytes as they were at the save. */
  objectKey: string;
  byteSize: number;
  /** Lower-case hex SHA-256. The build refuses bytes that do not match. */
  checksum: string;
}

/** What a save hands the build: the name of the Page and the snapshot of its folder. */
export interface PageBuildRequest {
  pageName: string;
  /** The folder of the workspace the files were taken from, for messages. */
  directory: string;
  files: PageBuildSourceFile[];
  /**
   * An HTML file of the folder opened on its own, where the folder has no `app.yaml`: the build
   * gives it the manifest of plain HTML with this file as its entry.
   */
  entry?: string;
  requestedByUserId?: UserId;
  /**
   * Set for the build of an asset's files. The source files then lie in the `files` store,
   * below the prefix of the file set named here, and the build stores that file set for the
   * asset instead of a revision of a Page.
   */
  asset?: { assetId: string; fileSetId: FileSetId };
}

/** One thing an author has to change before a Page builds. */
export interface PageBuildIssue {
  file: string;
  /** Counts from 1. */
  line?: number;
  /** Counts from 1. */
  column?: number;
  message: string;
  /** The authoring rule and its repair, for runtime_rule refusals. */
  rule?: string;
  sentence?: string;
  fix?: string;
  code?: string;
  /** The tag name, for an issue about one element of an HTML file. */
  element?: string;
  /** The attribute name, for an issue about one attribute. */
  attribute?: string;
}

/**
 * How a build ended. `saved`: the file set is stored. `errors`: the author's files do not
 * build, and nothing was stored. `failed`: the build itself gave no result, for example because
 * it was stopped at its time limit, and nothing was stored.
 *
 * `title` of a stored file set is the name the folder gives itself: the `name` of its own
 * manifest, or else the `<title>` of the HTML file it opens. It is absent where the folder
 * names none, and in results stored before it was added.
 */
export type PageSaveOutcome =
  | { status: "saved"; pageId: PageId; fileSetId: FileSetId; number: number; title?: string }
  | { status: "errors"; errors: PageBuildIssue[] }
  | PageBuildFailure;

/**
 * A build that gave no result. `reason` says why where the wait itself ended it: the time
 * limit passed, no worker takes builds, or the caller stopped waiting.
 */
export interface PageBuildFailure {
  status: "failed";
  message: string;
  reason?: "timeout" | "no_worker" | "stopped";
}

/** How the build of an asset's files ended. `stored`: the file set of the asset exists. */
export type AssetBuildOutcome =
  | { status: "stored"; fileSetId: FileSetId }
  | { status: "errors"; errors: PageBuildIssue[] }
  | PageBuildFailure;

/** What the row of a build holds once it ended. */
export type PageBuildResult = PageSaveOutcome | AssetBuildOutcome;

export interface PageBuild {
  id: PageBuildId;
  clientInstanceId: ClientInstanceId;
  /** The conversation of the Page. The build of an asset's files has none. */
  conversationId?: ConversationId;
  request: PageBuildRequest;
  /** Missing while the build is queued or running. */
  result?: PageBuildResult;
  createdAt: string;
  finishedAt?: string;
}

/**
 * The one way a save has a Page built: it hands over the snapshot and waits for how the build
 * ended. The tool that saves knows nothing of the queue and the process behind it.
 */
export interface PageBuildClient {
  build(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    request: PageBuildRequest;
    /** Aborting it ends the wait; the build is told to store nothing. */
    signal?: AbortSignal;
    /** Passing it ends the wait in the same way. */
    deadline?: Date;
  }): Promise<PageSaveOutcome>;
}

/**
 * How an asset write has its files built: it hands over where the source files lie and waits
 * for how the build ended. Builds of one asset run one at a time, in the order asked for.
 */
export interface AssetBuildClient {
  buildAsset(input: {
    clientInstanceId: ClientInstanceId;
    request: PageBuildRequest & { asset: NonNullable<PageBuildRequest["asset"]> };
    /** Aborting it ends the wait; the build is told to store nothing. */
    signal?: AbortSignal;
    /** Passing it ends the wait with the reason `timeout`. */
    deadline?: Date;
  }): Promise<AssetBuildOutcome>;
}

/**
 * How long the row of a build is kept when the save that asked for it never read its result.
 * A save removes its row when it has the result; a later save of the same conversation removes
 * the rows that are older than this.
 */
export const PAGE_BUILD_KEEP_MS = 60 * 60 * 1000;

/**
 * The rows of Pages and their file sets. A file set is written once: this store has no call
 * that changes or replaces one, and its id is new with every save, so no later save writes to
 * its row or below its object prefix.
 */
/** One person's small browser state in one App; erased with the App or the account. */
export interface AppUserStorageKey {
  clientInstanceId: ClientInstanceId;
  appId: string;
  userId: UserId;
}

export type AppUserStorageMutation =
  | { type: "set"; key: string; value: string }
  | { type: "remove"; key: string }
  | { type: "clear" }
  | { type: "batch"; clear: boolean; values: Record<string, string | null> };

/** Protects per-person state; larger business records belong in a Data Store. */
export const APP_USER_STORAGE_MAX_BYTES = 64 * 1024;

/**
 * Whose draft an outside host was allowed for: an App's draft, or a Page of a conversation
 * that is no App yet (DRAFT-HOSTS-1).
 */
export type DraftHostOwner = { kind: "app"; id: string } | { kind: "page"; id: PageId };

/** One person's allowance of one outside host for their own view of one draft. */
export interface DraftHostAllowanceKey {
  clientInstanceId: ClientInstanceId;
  owner: DraftHostOwner;
  userId: UserId;
}

export interface PagesStore {
  getAppUserStorage(input: AppUserStorageKey): Promise<Record<string, string>>;
  mutateAppUserStorage(
    input: AppUserStorageKey & { mutation: AppUserStorageMutation }
  ): Promise<void>;

  /**
   * Allows `host` for the person's own view of the owner's draft, from the owner's file set
   * `fileSetNumber` on. Allowed again, the row takes the new number and time. With `draftOf`,
   * the row is stored only while the App's draft and published revision are still those, and
   * a publish or discard that moves them waits for it or comes first: `false` says it came
   * first and nothing was stored.
   */
  allowDraftHost(
    input: DraftHostAllowanceKey & {
      host: string;
      fileSetNumber: number;
      allowedAt: string;
      draftOf?: { activeRevisionId: string; publishedRevisionId: string | undefined };
    }
  ): Promise<boolean>;
  /**
   * The hosts the person allowed that still hold for the owner's file set `shownNumber`: each
   * allowed on that file set or an earlier one, and listed by the manifest of every file set of
   * the owner from the one after it was allowed up to the shown one. A host that left the
   * manifest in between is no longer allowed, also where a later draft lists it again.
   */
  listDraftHostAllowances(
    input: DraftHostAllowanceKey & { shownNumber: number }
  ): Promise<string[]>;
  /**
   * Removes every person's allowances of the owner's draft: the draft was published or
   * discarded. Answers how many were removed.
   */
  removeDraftHostAllowances(input: {
    clientInstanceId: ClientInstanceId;
    owner: DraftHostOwner;
  }): Promise<number>;

  /**
   * The Page of that name in the conversation, created when there is none. Refuses the name
   * that would be one Page too many with `page_limit`.
   */
  ensurePage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    name: string;
    createdAt: string;
  }): Promise<Page>;
  /**
   * Stores the row of a file set of the Page and gives it the next number. Refuses with
   * `page_revision_limit` when the Page holds `PAGE_MAX_FILE_SETS` already.
   */
  createPageFileSet(input: {
    clientInstanceId: ClientInstanceId;
    pageId: PageId;
    fileSet: NewFileSet;
  }): Promise<FileSet>;
  listPages(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<Page[]>;
  getPage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    pageId: PageId;
  }): Promise<Page | undefined>;
  /** The file sets of a Page, newest first. */
  listPageFileSets(input: {
    clientInstanceId: ClientInstanceId;
    pageId: PageId;
  }): Promise<FileSetSummary[]>;
  /** One file set of a Page, or its newest when no id is given. */
  getPageFileSet(input: {
    clientInstanceId: ClientInstanceId;
    pageId: PageId;
    fileSetId?: FileSetId;
  }): Promise<FileSet | undefined>;
  /**
   * A file set by its id alone, for the content route, which knows nothing else. A file set
   * of a Page is found only while its conversation is active: a deleted or expired
   * conversation serves nothing, also before its cleanup ran. The conversation is named,
   * because who may still be served is decided by who may read it. A file set of an asset is
   * found while the asset is active, with the pointers that decide who is served it.
   */
  getServedFileSet(input: {
    clientInstanceId: ClientInstanceId;
    fileSetId: FileSetId;
  }): Promise<ServedFileSet | undefined>;
  /**
   * Stores the row of a file set an asset owns and gives it the next number of that asset.
   * The asset's row need not exist yet: a write that creates an asset stores its files first.
   */
  createAssetFileSet(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    fileSet: NewFileSet;
  }): Promise<FileSet>;
  getAssetFileSet(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    fileSetId: FileSetId;
  }): Promise<FileSet | undefined>;
  /**
   * Removes the row of one file set of an asset, for a write that stored it and then failed.
   * A file set that a revision of the asset names stays, and the answer is `false`: the write
   * was committed, whatever failed after it.
   */
  deleteAssetFileSet(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    fileSetId: FileSetId;
  }): Promise<boolean>;
  /** The Pages of a conversation whose rows are still there, for its cleanup. */
  listConversationPageIds(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<PageId[]>;
  /** Removes one Page and its file sets. Its stored objects are removed before this is called. */
  deletePage(input: {
    clientInstanceId: ClientInstanceId;
    pageId: PageId;
  }): Promise<{ fileSetCount: number }>;
  /**
   * Records a build that a save asks for, and removes the builds of the conversation that are
   * older than `PAGE_BUILD_KEEP_MS`. Inside `stores.transaction` it commits or rolls back with
   * the job that runs the build.
   */
  createPageBuild(input: {
    clientInstanceId: ClientInstanceId;
    id: PageBuildId;
    /** Left out for the build of an asset's files. */
    conversationId?: ConversationId;
    request: PageBuildRequest;
    createdAt: string;
  }): Promise<PageBuild>;
  getPageBuild(input: {
    clientInstanceId: ClientInstanceId;
    buildId: PageBuildId;
  }): Promise<PageBuild | undefined>;
  /**
   * Writes how a build ended. Answers false, and changes nothing, when the build has a result
   * already or its row is gone.
   */
  finishPageBuild(input: {
    clientInstanceId: ClientInstanceId;
    buildId: PageBuildId;
    result: PageBuildResult;
    finishedAt: string;
  }): Promise<boolean>;
  deletePageBuild(input: {
    clientInstanceId: ClientInstanceId;
    buildId: PageBuildId;
  }): Promise<void>;
}

/** Why a file set or a Page was refused, as `details.reason` of the error. */
export type PageRefusal =
  | "file_set_too_large"
  | "file_set_invalid"
  | "page_revision_limit"
  | "page_limit"
  | "page_name_invalid";

export function pageRefusal(
  reason: PageRefusal,
  message: string,
  details: JsonObject = {}
): AppError {
  return new AppError("VALIDATION_FAILED", message, { reason, ...details });
}

/** The object store prefix of everything an asset holds. */
export function assetObjectPrefix(assetId: string): string {
  return `assets/${assetId}/`;
}

/** The object store prefix of one file set, below the prefix of its owner. */
export function fileSetObjectPrefix(owner: FileSetOwner, fileSetId: FileSetId): string {
  return owner.kind === "page"
    ? pageFileSetObjectPrefix(owner.id, fileSetId)
    : `${assetObjectPrefix(owner.id)}${fileSetId}/`;
}

/** Where the bytes of one file of a file set are, whoever owns it. */
export function fileSetFileObjectKey(
  owner: FileSetOwner,
  fileSetId: FileSetId,
  part: "src" | "dist",
  path: string
): string {
  return `${fileSetObjectPrefix(owner, fileSetId)}${part}/${path}`;
}

/** The object store prefix of everything a Page holds. */
export function pageObjectPrefix(pageId: PageId): string {
  return `pages/${pageId}/`;
}

/** The object store prefix of one file set of a Page. */
export function pageFileSetObjectPrefix(pageId: PageId, fileSetId: FileSetId): string {
  return `${pageObjectPrefix(pageId)}${fileSetId}/`;
}

/** Where the bytes of one file of a file set are. `src` holds what was written, `dist` what was built. */
export function pageFileObjectKey(
  pageId: PageId,
  fileSetId: FileSetId,
  part: "src" | "dist",
  path: string
): string {
  return `${pageFileSetObjectPrefix(pageId, fileSetId)}${part}/${path}`;
}

const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;
// What a path may hold: the characters every object store and every address takes unchanged.
const PATH_SEGMENT = /^[A-Za-z0-9._@()+-][A-Za-z0-9._@()+ -]*$/u;

/** The reason a path cannot be a file of a file set, or nothing when it can. */
export function fileSetPathIssue(path: string): string | undefined {
  if (path.length === 0 || path.length > FILE_SET_MAX_PATH_CHARS) {
    return `a path has between 1 and ${FILE_SET_MAX_PATH_CHARS} characters`;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    return "a path is relative and names whole segments: no leading '/', no empty segment, no '.' and no '..'";
  }
  if (segments.some((segment) => !PATH_SEGMENT.test(segment) || segment.endsWith(" "))) {
    return "a path segment holds letters, digits, spaces and . _ @ ( ) + - only";
  }
  // At every depth: a relative address in an HTML file of a folder resolves below that folder.
  if (segments.some((segment) => segment.toLowerCase() === FILE_SET_RESERVED_SEGMENT)) {
    return `a folder named '${FILE_SET_RESERVED_SEGMENT}' is kept for the platform's own files, at every depth`;
  }
  return undefined;
}

/**
 * Refuses a file set over a limit or with a path that cannot be stored or served. `sizes`
 * holds every file of the set, source and built, by part and path.
 */
export function requireFileSetWithinLimits(
  files: readonly { part: "src" | "dist"; path: string; bytes: number }[],
  limits = {
    files: FILE_SET_MAX_FILES,
    fileBytes: FILE_SET_MAX_FILE_BYTES,
    treeBytes: FILE_SET_MAX_TOTAL_BYTES
  }
): void {
  if (files.length > limits.files) {
    throw pageRefusal(
      "file_set_too_large",
      `The Page has ${files.length} files. A Page holds at most ${limits.files} (FILE_SET_MAX_FILES), source and built files together.`,
      { cap: "FILE_SET_MAX_FILES", limit: limits.files, actual: files.length }
    );
  }
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const issue = fileSetPathIssue(file.path);
    if (issue) {
      throw pageRefusal("file_set_invalid", `The file '${file.path}' cannot be stored: ${issue}.`, {
        file: file.path
      });
    }
    // Compared without case: an object store on a file system may not tell the two apart.
    const key = `${file.part}/${file.path.toLowerCase()}`;
    if (seen.has(key)) {
      throw pageRefusal(
        "file_set_invalid",
        `The file '${file.path}' is in the Page twice. Paths differ by more than upper and lower case.`,
        { file: file.path }
      );
    }
    seen.add(key);
    if (file.bytes > limits.fileBytes) {
      throw pageRefusal(
        "file_set_too_large",
        `The file '${file.path}' has ${file.bytes} bytes. A file of a Page has at most ${megabytes(limits.fileBytes)} (FILE_SET_MAX_FILE_BYTES).`,
        {
          cap: "FILE_SET_MAX_FILE_BYTES",
          limit: limits.fileBytes,
          actual: file.bytes,
          file: file.path
        }
      );
    }
    total += file.bytes;
  }
  if (total > limits.treeBytes) {
    throw pageRefusal(
      "file_set_too_large",
      `The Page has ${total} bytes. A Page has at most ${megabytes(limits.treeBytes)} (FILE_SET_MAX_TOTAL_BYTES), source and built files together.`,
      { cap: "FILE_SET_MAX_TOTAL_BYTES", limit: limits.treeBytes, actual: total }
    );
  }
}

/** The name of a Page as it is stored: trimmed, and refused when empty or too long. */
export function normalizePageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > PAGE_NAME_MAX_CHARS) {
    throw pageRefusal(
      "page_name_invalid",
      `A Page name has between 1 and ${PAGE_NAME_MAX_CHARS} characters.`
    );
  }
  return trimmed;
}

// The type a file is served with follows from its name and from nothing a caller says: the
// type decides whether a browser runs a file, and an HTML file is never answered as stored.
const FILE_SET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  sql: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  jsx: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2"
};

/** The content type of a file of a file set, by its extension. Unknown is plain bytes. */
export function fileSetContentType(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/u.exec(path)?.[1]?.toLowerCase();
  return (extension && FILE_SET_CONTENT_TYPES[extension]) || "application/octet-stream";
}
