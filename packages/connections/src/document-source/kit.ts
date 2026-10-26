import {
  DocumentSourceError,
  documentSourceItemSchema,
  type ConnectorContext,
  type DocumentSourceBoundary,
  type DocumentSourceCapability,
  type DocumentSourceChange,
  type DocumentSourceErrorCode,
  type DocumentSourceItem
} from "@work-shape/catalyst-core";

// The contract test kit of the `document_source` capability (SRC-0). Every Connector type that
// declares the capability runs it in its own tests, against an in-process world (`fixture`) or
// recorded answers of its outside system (Box). The kit answers the problems it found, each
// with the rule it breaks, so a type that breaks one fails with the rule named. Spec:
// connections-and-secrets.md, "The `document_source` capability", check 59.

/** The rules the kit checks. */
export const DOCUMENT_SOURCE_KIT_RULES = [
  /** Every listed or changed item has the item shape, below a folder of the boundary. */
  "item_shape",
  /** Ids are stable across pages and calls: each item once per listing, the same ids twice. */
  "stable_ids",
  /** An item whose bytes changed is listed with another version. */
  "version_changes_with_bytes",
  /** A fetch under the cap answers the listed size in bytes, where the source lists one. */
  "fetch_bytes",
  /** A fetch of an item over the cap ends with `over_limit`, and no byte past the cap. */
  "size_cap",
  /** A refused credential answers `unauthorized`, never an empty listing. */
  "unauthorized",
  /**
   * `changes` answers `not_offered`, or a working feed: no change at a position taken without a
   * cursor, then an upload, a rename and a deletion made after it.
   */
  "changes_feed",
  /** A position the source refuses answers `cursor_expired`, never an empty change list. */
  "cursor_expired"
] as const;

export type DocumentSourceKitRule = (typeof DOCUMENT_SOURCE_KIT_RULES)[number];

export interface DocumentSourceKitProblem {
  rule: DocumentSourceKitRule;
  problem: string;
}

/**
 * What a type's test gives the kit: the capability, a boundary of folders that holds at least
 * four files over at least two pages, and the changes it can make at the source. The kit
 * changes three of the listed files besides the oversized one, so the world is spent after a
 * run.
 */
export interface DocumentSourceKitHarness {
  source: DocumentSourceCapability;
  boundary: DocumentSourceBoundary;
  /** A context whose credential the source accepts. */
  context: ConnectorContext;
  /** A context whose credential the source refuses. */
  refusedContext: ConnectorContext;
  /** The cap the kit fetches with. */
  maxBytes: number;
  /** An item below the boundary larger than `maxBytes`. */
  oversizedItemId: string;
  /** Adds a file below the boundary. */
  upload(): Promise<void>;
  /** Gives the item other bytes. */
  changeBytes(itemId: string): Promise<void>;
  /** Gives the item another name, which changes its path. */
  rename(itemId: string): Promise<void>;
  /** Deletes the item at the source. */
  remove(itemId: string): Promise<void>;
  /**
   * Makes the source refuse every position it handed out so far, as an expired stream
   * position. Needed where `changes` offers a feed.
   */
  expireCursors?(): Promise<void>;
}

/** How many pages or change calls the kit reads before it counts a walk as endless. */
const WALK_MAX_CALLS = 1_000;

/**
 * Runs every rule against the harness. Answers the problems found, none when the type holds to
 * the contract.
 */
export async function verifyDocumentSource(
  harness: DocumentSourceKitHarness
): Promise<DocumentSourceKitProblem[]> {
  const problems: DocumentSourceKitProblem[] = [];
  const report = (rule: DocumentSourceKitRule, problem: string) => {
    problems.push({ rule, problem });
  };
  const { source, boundary, context } = harness;

  const checkShape = (item: unknown, where: string) => {
    const parsed = documentSourceItemSchema.safeParse(item);
    if (!parsed.success) {
      report("item_shape", `${where}: ${parsed.error.issues[0]?.message ?? "not an item"}`);
      return;
    }
    if (!parsed.data.parents.some((parent) => boundary.folderIds.includes(parent))) {
      report("item_shape", `${where}: item ${parsed.data.id} names no folder of the boundary`);
    }
  };

  /** Every page of a listing, or the code it failed with. */
  const listAll = async (
    as: ConnectorContext
  ): Promise<{ pages: DocumentSourceItem[][] } | { code: DocumentSourceErrorCode | "other" }> => {
    const pages: DocumentSourceItem[][] = [];
    let pageToken: string | undefined;
    try {
      do {
        if (pages.length >= WALK_MAX_CALLS) throw new Error("the listing never ended");
        const page = await source.list({ boundary, ...(pageToken ? { pageToken } : {}) }, as);
        pages.push(page.items);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
    } catch (error) {
      return { code: error instanceof DocumentSourceError ? error.sourceCode : "other" };
    }
    return { pages };
  };

  const listOrReport = async (rule: DocumentSourceKitRule, when: string) => {
    const listing = await listAll(context);
    if ("code" in listing) {
      report(rule, `the listing ${when} failed with ${listing.code}`);
      return undefined;
    }
    return listing.pages;
  };

  const failureOf = async (call: () => Promise<unknown>): Promise<string> => {
    try {
      await call();
      return "answered";
    } catch (error) {
      return error instanceof DocumentSourceError ? error.sourceCode : "another error";
    }
  };

  /** The bytes a fetch yields, and the code it ended with. */
  const fetchBytes = async (
    item: Pick<DocumentSourceItem, "id" | "version">,
    maxBytes: number,
    as: ConnectorContext
  ): Promise<{ bytes: number; code?: DocumentSourceErrorCode | "other" }> => {
    let bytes = 0;
    try {
      for await (const chunk of source.fetch(
        { itemId: item.id, version: item.version, maxBytes, boundary },
        as
      )) {
        bytes += chunk.byteLength;
      }
      return { bytes };
    } catch (error) {
      return { bytes, code: error instanceof DocumentSourceError ? error.sourceCode : "other" };
    }
  };

  // Listing: shape and stable ids.
  const firstPages = await listOrReport("stable_ids", "before any change");
  if (!firstPages) return problems;
  const first = firstPages.flat();
  first.forEach((item, index) => checkShape(item, `listed item ${index + 1}`));
  const firstIds = first.map((item) => item.id);
  if (new Set(firstIds).size !== firstIds.length) {
    report("stable_ids", "an item is listed more than once in one listing");
  }
  if (firstPages.length < 2) {
    report("stable_ids", "the listing has one page: ids are not checked across pages");
  }
  const secondPages = await listOrReport("stable_ids", "read again");
  if (secondPages) {
    const again = new Set(secondPages.flat().map((item) => item.id));
    if (again.size !== new Set(firstIds).size || firstIds.some((id) => !again.has(id))) {
      report("stable_ids", "a second listing of the unchanged source names other ids");
    }
  }
  // Every later rule names items by their listed ids.
  if (problems.some((problem) => problem.rule === "stable_ids")) return problems;

  // A refused credential.
  const refused = await listAll(harness.refusedContext);
  if (!("code" in refused)) {
    const count = refused.pages.flat().length;
    report(
      "unauthorized",
      count === 0
        ? "a refused credential answered an empty listing"
        : `a refused credential answered a listing of ${count} items`
    );
  } else if (refused.code !== "unauthorized") {
    report("unauthorized", `a refused credential answered ${refused.code}, not unauthorized`);
  }
  const refusedChanges = await (async () => {
    try {
      const answer = await source.changes({ boundary }, harness.refusedContext);
      return answer.kind === "not_offered" ? "unauthorized" : "answered";
    } catch (error) {
      return error instanceof DocumentSourceError ? error.sourceCode : "another error";
    }
  })();
  if (refusedChanges !== "unauthorized") {
    report("unauthorized", `changes with a refused credential ${refusedChanges}`);
  }

  // Fetch and the size cap.
  const oversized = first.find((item) => item.id === harness.oversizedItemId);
  if (!oversized) {
    report("size_cap", "the oversized item is not listed");
  } else {
    const cut = await fetchBytes(oversized, harness.maxBytes, context);
    if (cut.code !== "over_limit") {
      report("size_cap", `a fetch over the cap ended with ${cut.code ?? "all its bytes"}`);
    }
    if (cut.bytes > harness.maxBytes) {
      report(
        "size_cap",
        `a fetch over the cap yielded ${cut.bytes - harness.maxBytes} bytes past it`
      );
    }
  }
  const files = first.filter((item) => item.id !== harness.oversizedItemId);
  const [smallest] = [...files].sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
  if (smallest) {
    const whole = await fetchBytes(
      smallest,
      Math.max(harness.maxBytes, smallest.size ?? 0),
      context
    );
    if (whole.code !== undefined) {
      report("fetch_bytes", `a fetch under the cap failed with ${whole.code}`);
    } else if (smallest.size !== undefined && whole.bytes !== smallest.size) {
      report(
        "fetch_bytes",
        `a fetch answered ${whole.bytes} bytes for a listed size of ${smallest.size}`
      );
    }
    const refusedFetch = await fetchBytes(smallest, harness.maxBytes, harness.refusedContext);
    if (refusedFetch.code !== "unauthorized") {
      report(
        "unauthorized",
        `a fetch with a refused credential ended with ${refusedFetch.code ?? "the bytes"}`
      );
    }
  }

  // Changes: a position, then an upload, a rename, a deletion and new bytes.
  const [renamed, removed, rewritten] = files;
  if (!renamed || !removed || !rewritten) {
    throw new Error(
      "The harness lists fewer than three files besides the oversized one: the kit changes three"
    );
  }
  let start: Awaited<ReturnType<DocumentSourceCapability["changes"]>> | undefined;
  try {
    start = await source.changes({ boundary }, context);
  } catch (error) {
    report(
      "changes_feed",
      `taking a position failed with ${error instanceof DocumentSourceError ? error.sourceCode : "another error"}`
    );
  }
  if (start?.kind === "changes" && start.changes.length > 0) {
    report("changes_feed", "a position taken without a cursor answered changes");
  }

  await harness.upload();
  await harness.rename(renamed.id);
  await harness.remove(removed.id);
  await harness.changeBytes(rewritten.id);

  const afterPages = await listOrReport("version_changes_with_bytes", "after the changes");
  if (afterPages) {
    const after = new Map(afterPages.flat().map((item) => [item.id, item]));
    const now = after.get(rewritten.id);
    if (!now) {
      report("stable_ids", "an item whose bytes changed is listed under another id");
    } else if (now.version === rewritten.version) {
      report("version_changes_with_bytes", "an item whose bytes changed keeps its version");
    }
    const renamedNow = after.get(renamed.id);
    if (!renamedNow) {
      report("stable_ids", "a renamed item is listed under another id");
    }
  }

  if (start?.kind === "changes") {
    const seen: DocumentSourceChange[] = [];
    let cursor = start.nextCursor;
    let failed = false;
    try {
      for (let call = 0; ; call += 1) {
        if (call >= WALK_MAX_CALLS) throw new Error("the change feed never ended");
        const answer = await source.changes({ boundary, cursor }, context);
        if (answer.kind !== "changes") {
          report("changes_feed", "the feed answered not_offered after it gave a position");
          failed = true;
          break;
        }
        seen.push(...answer.changes);
        cursor = answer.nextCursor;
        if (answer.changes.length === 0) break;
      }
    } catch (error) {
      report(
        "changes_feed",
        `reading changes failed with ${error instanceof DocumentSourceError ? error.sourceCode : "another error"}`
      );
      failed = true;
    }
    if (!failed) {
      seen.forEach((change, index) => {
        if (change.kind === "upsert") checkShape(change.item, `changed item ${index + 1}`);
      });
      const upserts = seen.flatMap((change) => (change.kind === "upsert" ? [change.item] : []));
      const deleted = new Set(
        seen.flatMap((change) => (change.kind === "delete" ? [change.item.id] : []))
      );
      const known = new Set(firstIds);
      if (!upserts.some((item) => !known.has(item.id))) {
        report("changes_feed", "an upload after the position is not among the changes");
      }
      if (!upserts.some((item) => item.id === renamed.id && item.name !== renamed.name)) {
        report("changes_feed", "a rename after the position is not among the changes");
      }
      if (!deleted.has(removed.id)) {
        report("changes_feed", "a deletion after the position is not among the changes");
      }
      if (!upserts.some((item) => item.id === rewritten.id && item.version !== rewritten.version)) {
        report("changes_feed", "new bytes after the position are not among the changes");
      }
    }

    // A position the source no longer accepts.
    if (!harness.expireCursors) {
      report("cursor_expired", "the harness cannot make the source refuse a position");
    } else {
      await harness.expireCursors();
      const answer = await failureOf(() =>
        source.changes({ boundary, cursor: start.nextCursor }, context)
      );
      if (answer !== "cursor_expired") {
        report(
          "cursor_expired",
          answer === "answered"
            ? "a refused position answered a change list"
            : `a refused position answered ${answer}, not cursor_expired`
        );
      }
    }
  }

  return problems;
}
