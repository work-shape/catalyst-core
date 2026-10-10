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
 * The first path segment the platform keeps for its own files beside a Page's. No file of a
 * file set may lie below it.
 */
export const FILE_SET_RESERVED_SEGMENT = "__catalyst";

/** Who a file set belongs to. S3-40 adds the owner `asset`. */
export type FileSetOwner = { kind: "page"; id: PageId };

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

/**
 * The rows of Pages and their file sets. A file set is written once: this store has no call
 * that changes or replaces one, and its id is new with every save, so no later save writes to
 * its row or below its object prefix.
 */
export interface PagesStore {
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
   * A file set by its id alone, for the content route, which knows nothing else. Only a file
   * set whose conversation is active is found: a deleted or expired conversation serves
   * nothing, also before its cleanup ran.
   */
  getServedFileSet(input: {
    clientInstanceId: ClientInstanceId;
    fileSetId: FileSetId;
  }): Promise<FileSet | undefined>;
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
  if (segments[0]?.toLowerCase() === FILE_SET_RESERVED_SEGMENT) {
    return `'${FILE_SET_RESERVED_SEGMENT}/' is kept for the platform's own files`;
  }
  return undefined;
}

/**
 * Refuses a file set over a limit or with a path that cannot be stored or served. `sizes`
 * holds every file of the set, source and built, by part and path.
 */
export function requireFileSetWithinLimits(
  files: readonly { part: "src" | "dist"; path: string; bytes: number }[]
): void {
  if (files.length > FILE_SET_MAX_FILES) {
    throw pageRefusal(
      "file_set_too_large",
      `The Page has ${files.length} files. A Page holds at most ${FILE_SET_MAX_FILES} (FILE_SET_MAX_FILES), source and built files together.`,
      { cap: "FILE_SET_MAX_FILES", limit: FILE_SET_MAX_FILES, actual: files.length }
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
    if (file.bytes > FILE_SET_MAX_FILE_BYTES) {
      throw pageRefusal(
        "file_set_too_large",
        `The file '${file.path}' has ${file.bytes} bytes. A file of a Page has at most ${megabytes(FILE_SET_MAX_FILE_BYTES)} (FILE_SET_MAX_FILE_BYTES).`,
        {
          cap: "FILE_SET_MAX_FILE_BYTES",
          limit: FILE_SET_MAX_FILE_BYTES,
          actual: file.bytes,
          file: file.path
        }
      );
    }
    total += file.bytes;
  }
  if (total > FILE_SET_MAX_TOTAL_BYTES) {
    throw pageRefusal(
      "file_set_too_large",
      `The Page has ${total} bytes. A Page has at most ${megabytes(FILE_SET_MAX_TOTAL_BYTES)} (FILE_SET_MAX_TOTAL_BYTES), source and built files together.`,
      { cap: "FILE_SET_MAX_TOTAL_BYTES", limit: FILE_SET_MAX_TOTAL_BYTES, actual: total }
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
