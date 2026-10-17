import { describe, expect, it } from "vitest";
import {
  createFixtureDocumentSource,
  verifyDocumentSource,
  type DocumentSourceKitHarness,
  type DocumentSourceKitRule
} from "@work-shape/catalyst-connections";
import {
  DocumentSourceError,
  type ConnectorContext,
  type DocumentSourceCapability
} from "@work-shape/catalyst-core";

// The contract test kit of the `document_source` capability against the `fixture` source: the
// fixture passes it, and a source that breaks one rule fails it with that rule named. Spec:
// connections-and-secrets.md, "The `document_source` capability", check 59.

const SECRET = "fixture-secret";
const FOLDER = "folder-1";
const MAX_BYTES = 4_096;

const encoder = new TextEncoder();

/** A context as the platform hands one to a call, with `secret` as the Connection's credential. */
function contextWith(secret: string): ConnectorContext {
  const target = {
    protocol: "https" as const,
    host: "fixture.invalid",
    port: 443,
    address: "192.0.2.1",
    family: 4 as const,
    network: "public" as const
  };
  return {
    connection: {
      id: "connection-1",
      name: "fixture",
      revision: 1,
      settings: {},
      authScheme: "bearer",
      operations: []
    },
    target,
    checkEgress: () => Promise.resolve(target),
    credentialFor: () => ({ scheme: "bearer", secret, headers: {} }),
    signal: new AbortController().signal
  };
}

/** A fresh fixture world with five files over three pages, one of them over the cap. */
function harnessOf(
  wrap: (source: DocumentSourceCapability) => DocumentSourceCapability = (source) => source
): DocumentSourceKitHarness {
  const { connectorType, world } = createFixtureDocumentSource({ secret: SECRET });
  const capability = connectorType.documentSource;
  if (!capability) throw new Error("The fixture type must offer document_source");
  const put = (name: string, size: number) =>
    world.put({ folderId: FOLDER, name, mime: "text/plain", bytes: new Uint8Array(size).fill(65) });
  put("a.txt", 10);
  put("b.txt", 2_000);
  put("c.txt", 3_000);
  put("d.txt", 50);
  const oversizedItemId = put("large.txt", MAX_BYTES * 3);
  // A file outside the boundary, which no call may answer.
  world.put({
    folderId: "folder-2",
    name: "elsewhere.txt",
    mime: "text/plain",
    bytes: encoder.encode("x")
  });
  let uploads = 0;
  return {
    source: wrap(capability),
    boundary: { folderIds: [FOLDER] },
    context: contextWith(SECRET),
    refusedContext: contextWith("wrong"),
    maxBytes: MAX_BYTES,
    oversizedItemId,
    upload: () => {
      uploads += 1;
      put(`new-${uploads}.txt`, 20);
      return Promise.resolve();
    },
    changeBytes: (itemId) => {
      world.write(itemId, encoder.encode("other bytes"));
      return Promise.resolve();
    },
    rename: (itemId) => {
      world.rename(itemId, "renamed.txt");
      return Promise.resolve();
    },
    remove: (itemId) => {
      world.remove(itemId);
      return Promise.resolve();
    },
    expireCursors: () => {
      world.expireCursors();
      return Promise.resolve();
    }
  };
}

const rulesOf = async (harness: DocumentSourceKitHarness): Promise<DocumentSourceKitRule[]> => [
  ...new Set((await verifyDocumentSource(harness)).map((problem) => problem.rule))
];

describe("the document_source contract test kit", () => {
  it("passes the fixture source", async () => {
    await expect(verifyDocumentSource(harnessOf())).resolves.toEqual([]);
  });

  it("passes a source without a change feed that answers not_offered", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      changes: () => Promise.resolve({ kind: "not_offered" })
    }));
    await expect(verifyDocumentSource({ ...harness, expireCursors: undefined })).resolves.toEqual(
      []
    );
  });

  it("names stable_ids for ids that change from one listing to the next", async () => {
    let call = 0;
    const harness = harnessOf((source) => ({
      ...source,
      async list(input, context) {
        call += 1;
        const page = await source.list(input, context);
        return {
          ...page,
          items: page.items.map((item) => ({ ...item, id: `${item.id}-${call}` }))
        };
      }
    }));
    expect(await rulesOf(harness)).toEqual(["stable_ids"]);
  });

  it("names version_changes_with_bytes for a version that never changes", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      async list(input, context) {
        const page = await source.list(input, context);
        return { ...page, items: page.items.map((item) => ({ ...item, version: "v1" })) };
      }
    }));
    expect(await rulesOf(harness)).toEqual(["version_changes_with_bytes"]);
  });

  it("names changes_feed for a feed that leaves deletions out", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      async changes(input, context) {
        const answer = await source.changes(input, context);
        return answer.kind === "changes"
          ? { ...answer, changes: answer.changes.filter((change) => change.kind !== "delete") }
          : answer;
      }
    }));
    const problems = await verifyDocumentSource(harness);
    expect(problems).toEqual([
      { rule: "changes_feed", problem: "a deletion after the position is not among the changes" }
    ]);
  });

  it("names cursor_expired for a refused position answered with no changes", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      async changes(input, context) {
        try {
          return await source.changes(input, context);
        } catch (error) {
          if (error instanceof DocumentSourceError && error.sourceCode === "cursor_expired") {
            return { kind: "changes", changes: [], nextCursor: input.cursor ?? "" };
          }
          throw error;
        }
      }
    }));
    expect(await rulesOf(harness)).toEqual(["cursor_expired"]);
  });

  it("names size_cap for a fetch that reads past the cap", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      fetch: (input, context) =>
        source.fetch({ ...input, maxBytes: Number.MAX_SAFE_INTEGER }, context)
    }));
    expect(await rulesOf(harness)).toEqual(["size_cap"]);
  });

  it("names unauthorized for a refused credential answered with an empty listing", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      async list(input, context) {
        try {
          return await source.list(input, context);
        } catch (error) {
          if (error instanceof DocumentSourceError && error.sourceCode === "unauthorized") {
            return { items: [] };
          }
          throw error;
        }
      }
    }));
    const problems = await verifyDocumentSource(harness);
    expect(problems).toEqual([
      { rule: "unauthorized", problem: "a refused credential answered an empty listing" }
    ]);
  });

  it("names item_shape for an item outside the boundary", async () => {
    const harness = harnessOf((source) => ({
      ...source,
      async list(input, context) {
        const page = await source.list(input, context);
        return { ...page, items: page.items.map((item) => ({ ...item, parents: ["folder-9"] })) };
      }
    }));
    expect(await rulesOf(harness)).toContain("item_shape");
  });
});
