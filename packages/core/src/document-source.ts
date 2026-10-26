import { z } from "zod";
import { AppError, type AppErrorCode } from "./errors";

// The `document_source` capability of a Connector type: what a document management system
// gives a Knowledge Base that syncs from it. A Connector type declares it beside its
// operations (`ConnectorTypeDefinition.documentSource`, whose calls `DocumentSourceCapability`
// in `connections.ts` names). Spec: connections-and-secrets.md,
// "The `document_source` capability"; data-stores-and-knowledge-bases.md, Synced sources.
//
// The caller of `list`, `changes` and `fetch` is the sync of a Knowledge Base
// (`knowledge_base.sync` and `knowledge_base.fetch`), acting as the Knowledge Base's ingestion
// principal. The optional `folders` is called by a person choosing a source's folders, through
// `connections.source_folders` and with `connection.use` on the Connection; it answers folder
// names and ids, never items. None is a catalogue operation: none is listed among a
// Connection's operations or has an exposure, and no agent, App, Workflow step or bridge reaches
// one. Each call gets a `ConnectorContext` from the platform, so it runs on the same credential
// resolver, egress checker and limits as every call of the Connection.
//
// Sensitive data. Items carry file names and paths, which can name people. They go into the
// Knowledge Base's own store and never into a job payload, an error, a log line or an audit
// event. A `DocumentSourceError` carries a code and a sentence that names no item; a provider's
// body is never passed on.

/** Where a source is read: folder ids of the outside system, never a path. */
export interface DocumentSourceBoundary {
  folderIds: readonly string[];
}

/**
 * One item of a source, as `list` and `changes` answer it.
 *
 * - `id` is stable for the item's life at the source: a rename or a move keeps it.
 * - `version` changes when its bytes change, and only then may a fetch answer other bytes.
 * - `path` is for people and for the `exclude` rule, never the boundary. It starts with `/`
 *   and is relative to the folder of the boundary the item is below.
 * - `parents` are the folder ids above it, nearest first. The sync checks them against the
 *   boundary on every change, because a feed may report items outside it.
 */
export const documentSourceItemSchema = z.strictObject({
  id: z.string().min(1).max(500),
  version: z.string().min(1).max(500),
  path: z.string().startsWith("/").max(4_000),
  name: z.string().min(1).max(1_000),
  mime: z.string().min(1).max(255),
  /** The size in bytes as the source lists it. */
  size: z.number().int().min(0),
  modifiedAt: z.iso.datetime({ offset: true }),
  /** Where a person opens the original at the source, such as the file's address in Box. */
  originLink: z
    .url({ protocol: /^https?$/u })
    .max(4_000)
    .optional(),
  parents: z.array(z.string().min(1).max(500)).min(1)
});

export type DocumentSourceItem = z.infer<typeof documentSourceItemSchema>;

/** A change since a cursor: an item added, changed, renamed or moved, or deleted. A deletion carries the id only. */
export const documentSourceChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upsert"), item: documentSourceItemSchema }),
  z.strictObject({ kind: z.literal("delete"), item: z.strictObject({ id: z.string().min(1) }) })
]);

export type DocumentSourceChange = z.infer<typeof documentSourceChangeSchema>;

export interface DocumentSourceListInput {
  boundary: DocumentSourceBoundary;
  /** The `nextPageToken` of the page before. Left out, the first page. */
  pageToken?: string;
}

export interface DocumentSourceListPage {
  items: DocumentSourceItem[];
  /** Present while pages follow. A listing is complete only once a page answers none. */
  nextPageToken?: string;
}

export interface DocumentSourceChangesInput {
  boundary: DocumentSourceBoundary;
  /**
   * The `nextCursor` of the call before. Left out, the source answers its current position and
   * no changes: the position a sync takes before its initial listing.
   */
  cursor?: string;
}

/**
 * What `changes` answers. A type without a change feed answers `not_offered`, and the sync
 * compares full listings instead. The sync calls again with `nextCursor` until a call answers
 * no change.
 */
export type DocumentSourceChanges =
  | { kind: "changes"; changes: DocumentSourceChange[]; nextCursor: string }
  | { kind: "not_offered" };

export interface DocumentSourceFetchInput {
  /** Current source boundary, checked again against live parents before downloading.
   * Required by outside sources; optional for legacy in-process fixture adapters. */
  boundary?: DocumentSourceBoundary;
  itemId: string;
  /** The version the listing named. A source that holds another answers `not_found`. */
  version: string;
  /**
   * The size cap. The stream yields no byte past it: where the item is larger, it ends with
   * `over_limit` once the cap is passed, and nothing past the cap is read from the source.
   */
  maxBytes: number;
}

/**
 * What a person choosing a source's folders asks: the folders directly inside one folder.
 * Left out, `parentId` names the top the Connection's account sees.
 */
export interface DocumentSourceFoldersInput {
  parentId?: string;
  /** The `nextPageToken` of the page before. Left out, the first page. */
  pageToken?: string;
}

/** One folder, as a person chooses it. */
export interface DocumentSourceFolder {
  id: string;
  name: string;
}

/** What `folders` answers: the folder asked about, and one page of the folders inside it. */
export interface DocumentSourceFolderPage {
  /** The folder listed, with its path from the top, such as `/Objekte/2024`; `/` for the top. */
  folder: DocumentSourceFolder & { path: string };
  folders: DocumentSourceFolder[];
  /** Present while pages follow. */
  nextPageToken?: string;
}

/**
 * The failures a document source names:
 *
 * - `unauthorized`: the credential was refused. The sync stops and withdraws nothing.
 * - `forbidden`, `not_found`: for one item; a fetch answered so withdraws the item.
 * - `rate_limited`: wait `retryAfterMs`; the batch is rescheduled and spends no attempt.
 * - `unavailable`: the source did not answer.
 * - `cursor_expired`: the source no longer accepts the cursor; the sync starts a full pass.
 * - `over_limit`: the item is larger than the cap; nothing past the cap was read.
 */
export const DOCUMENT_SOURCE_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "unavailable",
  "cursor_expired",
  "over_limit"
] as const;

export type DocumentSourceErrorCode = (typeof DOCUMENT_SOURCE_ERROR_CODES)[number];

const APP_ERROR_CODE_OF: Record<DocumentSourceErrorCode, AppErrorCode> = {
  unauthorized: "FORBIDDEN",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  rate_limited: "RATE_LIMITED",
  unavailable: "TIMEOUT",
  cursor_expired: "CONFLICT",
  over_limit: "VALIDATION_FAILED"
};

/**
 * A failure of a document source call. The message is for the worker's log: it names no item
 * and holds no provider body.
 */
export class DocumentSourceError extends AppError {
  readonly sourceCode: DocumentSourceErrorCode;
  /** For `rate_limited`: how long the source asks to wait, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(code: DocumentSourceErrorCode, message: string, options?: { retryAfterMs?: number }) {
    super(APP_ERROR_CODE_OF[code], message, { reason: code });
    this.name = "DocumentSourceError";
    this.sourceCode = code;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** The code of a failure of a document source call: an error that names none counts as `unavailable`. */
export function documentSourceErrorCodeOf(error: unknown): DocumentSourceErrorCode {
  return error instanceof DocumentSourceError ? error.sourceCode : "unavailable";
}
