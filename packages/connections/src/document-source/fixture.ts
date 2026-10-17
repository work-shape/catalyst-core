import { z } from "zod";
import {
  DocumentSourceError,
  type ConnectorContext,
  type ConnectorTypeDefinition,
  type DocumentSourceCapability,
  type DocumentSourceChange,
  type DocumentSourceItem
} from "@work-shape/catalyst-core";

// The `fixture` document source: an in-process world of folders and files that answers the
// `document_source` contract, for the tests of the sync and as the reference the kit runs
// against. This is the skeleton SRC-0 freezes the kit with; SRC-1a makes it a Connector type
// of its own, configurable with failures. It holds everything in memory and reaches nothing
// outside the process.

/** A file as a test puts it into the world. */
export interface FixtureDocumentFile {
  /** The folder it is in. */
  folderId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** How a test changes the world, as a person would at the source. */
export interface FixtureDocumentWorld {
  /** Adds a file and answers its id. */
  put(file: FixtureDocumentFile): string;
  /** Gives the file other bytes, and so a new version. */
  write(itemId: string, bytes: Uint8Array): void;
  rename(itemId: string, name: string): void;
  move(itemId: string, folderId: string): void;
  remove(itemId: string): void;
  /** Makes every cursor handed out so far refused, as an expired stream position. */
  expireCursors(): void;
}

interface StoredFile {
  id: string;
  folderId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  version: number;
  modifiedAt: string;
}

/** How many items one page of `list` holds. Small, so a few files make several pages. */
const FIXTURE_PAGE_SIZE = 2;
/** How many bytes one chunk of `fetch` yields. */
const FIXTURE_CHUNK_BYTES = 1_024;

/**
 * A world and the capability that reads it. A call is accepted only with the credential
 * `secret`; any other answers `unauthorized`.
 */
export function createFixtureDocumentSource(input: {
  secret: string;
  /** Page size for import tests; the contract kit uses the default of two. */
  pageSize?: number;
  /** False simulates a source without a change feed. */
  feed?: boolean;
  /** Inject named failures, including Retry-After, without an outside service. */
  failure?: (call: {
    kind: "list" | "changes" | "fetch";
    itemId?: string;
  }) => DocumentSourceError | undefined;
  /** The time each change is stamped with. */
  now?: () => Date;
}): {
  capability: DocumentSourceCapability;
  world: FixtureDocumentWorld;
  connectorType: ConnectorTypeDefinition;
} {
  const pageSize = input.pageSize ?? FIXTURE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
    throw new Error("A fixture page holds 1 to 1000 items");
  const now = input.now ?? (() => new Date());
  const files = new Map<string, StoredFile>();
  const feed: DocumentSourceChange[] = [];
  let nextId = 1;
  /** Raised by `expireCursors`: a cursor of an earlier epoch is refused. */
  let epoch = 1;

  const itemOf = (file: StoredFile): DocumentSourceItem => ({
    id: file.id,
    version: `v${file.version}`,
    path: `/${file.name}`,
    name: file.name,
    mime: file.mime,
    size: file.bytes.byteLength,
    modifiedAt: file.modifiedAt,
    originLink: `https://fixture.invalid/files/${file.id}`,
    parents: [file.folderId]
  });

  const stored = (itemId: string): StoredFile => {
    const file = files.get(itemId);
    if (!file) throw new Error(`The fixture holds no file ${itemId}`);
    return file;
  };

  const changed = (file: StoredFile) => {
    file.modifiedAt = now().toISOString();
    feed.push({ kind: "upsert", item: itemOf(file) });
  };

  const authenticate = (context: ConnectorContext) => {
    if (context.credentialFor(context.target)?.secret !== input.secret) {
      throw new DocumentSourceError("unauthorized", "The fixture refused the credential");
    }
  };

  const cursorAt = (position: number) => `e${epoch}p${position}`;
  const positionOf = (cursor: string): number => {
    const match = /^e(\d+)p(\d+)$/u.exec(cursor);
    const position = Number(match?.[2]);
    if (Number(match?.[1]) !== epoch || !(position >= 0 && position <= feed.length)) {
      throw new DocumentSourceError("cursor_expired", "The fixture refused the position");
    }
    return position;
  };

  const world: FixtureDocumentWorld = {
    put(file) {
      const id = `f${nextId++}`;
      const entry: StoredFile = { id, ...file, version: 1, modifiedAt: "" };
      files.set(id, entry);
      changed(entry);
      return id;
    },
    write(itemId, bytes) {
      const file = stored(itemId);
      file.bytes = bytes;
      file.version += 1;
      changed(file);
    },
    rename(itemId, name) {
      const file = stored(itemId);
      file.name = name;
      changed(file);
    },
    move(itemId, folderId) {
      const file = stored(itemId);
      file.folderId = folderId;
      changed(file);
    },
    remove(itemId) {
      stored(itemId);
      files.delete(itemId);
      feed.push({ kind: "delete", item: { id: itemId } });
    },
    expireCursors() {
      epoch += 1;
    }
  };

  const capability: DocumentSourceCapability = {
    list({ boundary, pageToken }, context) {
      authenticate(context);
      const failure = input.failure?.({ kind: "list" });
      if (failure) throw failure;
      context.signal.throwIfAborted();
      const below = [...files.values()]
        .filter((file) => boundary.folderIds.includes(file.folderId))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const start = pageToken === undefined ? 0 : below.findIndex((file) => file.id > pageToken);
      const page = start < 0 ? [] : below.slice(start, start + pageSize);
      const last = page.at(-1);
      const more = last !== undefined && below.at(-1)?.id !== last.id;
      return Promise.resolve({
        items: page.map(itemOf),
        ...(more ? { nextPageToken: last.id } : {})
      });
    },

    changes({ boundary, cursor }, context) {
      authenticate(context);
      const failure = input.failure?.({ kind: "changes" });
      if (failure) throw failure;
      context.signal.throwIfAborted();
      if (input.feed === false) return Promise.resolve({ kind: "not_offered" });
      if (cursor === undefined) {
        return Promise.resolve({ kind: "changes", changes: [], nextCursor: cursorAt(feed.length) });
      }
      const from = positionOf(cursor);
      const batch = feed.slice(from, from + pageSize);
      return Promise.resolve({
        kind: "changes",
        // A feed reports items outside the boundary too; the fixture's does not.
        changes: batch.filter(
          (change) =>
            change.kind === "delete" ||
            change.item.parents.some((parent) => boundary.folderIds.includes(parent))
        ),
        nextCursor: cursorAt(from + batch.length)
      });
    },

    async *fetch({ itemId, version, maxBytes }, context) {
      authenticate(context);
      const failure = input.failure?.({ kind: "fetch", itemId });
      if (failure) throw failure;
      context.signal.throwIfAborted();
      const file = files.get(itemId);
      if (!file || `v${file.version}` !== version) {
        throw new DocumentSourceError("not_found", "The fixture holds no such version");
      }
      // A copy, so a write during the stream does not change what it yields.
      const bytes = file.bytes.slice();
      for (let offset = 0; offset < bytes.byteLength; offset += FIXTURE_CHUNK_BYTES) {
        context.signal.throwIfAborted();
        const end = Math.min(offset + FIXTURE_CHUNK_BYTES, bytes.byteLength);
        if (end > maxBytes) {
          throw new DocumentSourceError("over_limit", "The item is larger than the cap");
        }
        yield bytes.subarray(offset, end);
      }
    }
  };

  return {
    capability,
    world,
    connectorType: {
      type: "fixture",
      description: "In-process document source for import and connector contract tests.",
      settingsSchema: z.strictObject({}),
      authSchemes: ["bearer"],
      secretFields: ["secret"],
      catalog: [],
      target: () => ({ protocol: "https", host: "fixture.invalid", port: 443 }),
      limits: { callTimeoutMs: 60000, resultMaxBytes: 1024 * 1024, maxParallelCalls: 4 },
      documentSource: capability,
      async test(context) {
        authenticate(context);
        return { status: "ready" };
      },
      async execute() {
        throw new Error("The fixture offers documents and no operations");
      }
    }
  };
}
