import { describe, expect, it } from "vitest";
import {
  DocumentSourceError,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_SOURCE_UNREACHABLE,
  knowledgePageCachePrefix,
  StoreBackedAuditRecorder,
  type DocumentSourceCapability
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { asMember, developmentAuth } from "./support/knowledge-files";
import { knowledgePublisher, useKnowledgeSync } from "./support/knowledge-sync";

// KB-13b: a cited page of a synced document whose original was released after extraction is
// fetched through the source's Connection into a page cache of 7 days, bounded per Knowledge
// Base. Spec: data-stores-and-knowledge-bases.md, "Originals stay in the DMS" and the page
// cache's assumptions on retention, audit, authorization and region.

const KB = "sync-test";
const encode = (text: string) => new TextEncoder().encode(text);

type World = Awaited<ReturnType<ReturnType<typeof useKnowledgeSync>["setup"]>>;

/** A source whose fetches are counted, and which a test can take down. */
function countedSource() {
  const state = { fetches: 0, down: false };
  const wrap = (source: DocumentSourceCapability): DocumentSourceCapability => ({
    ...source,
    async *fetch(input, context) {
      state.fetches++;
      if (state.down) throw new DocumentSourceError("unavailable", "The source is down");
      yield* source.fetch(input, context);
    }
  });
  return { state, wrap };
}

/** Puts the files, syncs them, and answers each one's document id by file name. */
async function synced(world: World, files: Record<string, string>) {
  const items: Record<string, string> = {};
  for (const [name, text] of Object.entries(files))
    items[name] = world.world.put({
      folderId: "folder",
      name,
      mime: "text/plain",
      bytes: encode(text)
    });
  await world.drain(await world.sync());
  const rows = await world.sql`select d.id, i.name, i.item_id from catalyst_kb.documents d
    join catalyst_kb.source_items i on i.id = d.source_item_id`;
  const ids: Record<string, string> = {};
  for (const row of rows) ids[String(row.name)] = String(row.id);
  expect(
    await world.platform`select distinct status from managed_files where owner_id=${world.record.id}`
  ).toEqual([{ status: "released" }]);
  return { ids, items };
}

function reader(world: World) {
  return {
    actor: knowledgePublisher,
    audit: new StoreBackedAuditRecorder({ clientInstanceId, store: world.instance.stores.audit }),
    correlationId: "corr_page"
  };
}

async function open(world: World, documentId: string) {
  const opened = await world.knowledge.openDocument(
    world.files,
    KB,
    documentId,
    undefined,
    reader(world)
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of opened.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function cachedObjects(world: World, documentId?: string) {
  const page = await world.objects.list(knowledgePageCachePrefix(world.record.id, documentId));
  return page.objects.map((object) => object.key);
}

async function fetchEvents(world: World) {
  return world.platform`select status, reason, metadata from audit_events
    where type = 'knowledge_base.page_fetched' order by created_at`;
}

/** Runs the expiry job now instead of at the next entry's expiry. */
async function runExpiry(world: World) {
  const [wake] = await world.platform`update platform_job_wakes set run_after = now()
    where kind = 'knowledge_base.expire_page_cache' returning kind`;
  expect(wake).toBeDefined();
  await world.worker.runDue();
}

describe("the page cache of cited synced documents (KB 76)", () => {
  const { setup } = useKnowledgeSync();

  it("fetches a released original on a miss, serves the cache on a hit, and audits the fetch without content", async () => {
    const source = countedSource();
    const world = await setup(source.wrap);
    const { ids } = await synced(world, { "Lease Example.txt": "Rent 1,250 EUR." });
    const documentId = required(ids["Lease Example.txt"]);
    source.state.fetches = 0;
    world.openSource.mockClear();

    expect(await open(world, documentId)).toBe("Rent 1,250 EUR.");
    expect(source.state.fetches).toBe(1);
    // Through the Connection the source was synced with, as the sync opens it.
    expect(world.openSource.mock.calls.map(([name]) => name)).toEqual(["fixture"]);
    expect(await cachedObjects(world, documentId)).toHaveLength(1);
    const [entry] = await world.sql`select byte_size::int as bytes,
      expires_at - cached_at as lifetime from catalyst_kb.page_cache where document_id=${documentId}`;
    expect(entry?.bytes).toBe(15);
    expect(String(entry?.lifetime)).toMatch(/7 days|168:00:00/);

    expect(await open(world, documentId)).toBe("Rent 1,250 EUR.");
    expect(source.state.fetches).toBe(1);

    const events = await fetchEvents(world);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "success",
      metadata: { knowledgeBase: KB, documentId, source: "source", bytes: 15 }
    });
    const audited = JSON.stringify(events);
    expect(audited).not.toContain("Lease Example");
    expect(audited).not.toContain("Rent");
  });

  it("fetches again after 7 days and the expiry job deletes the entry and its object", async () => {
    const source = countedSource();
    const world = await setup(source.wrap);
    const { ids } = await synced(world, { "a.txt": "First page." });
    const documentId = required(ids["a.txt"]);
    source.state.fetches = 0;
    await open(world, documentId);
    await world.sql`update catalyst_kb.page_cache set expires_at = now() - interval '1 second'`;

    expect(await open(world, documentId)).toBe("First page.");
    expect(source.state.fetches).toBe(2);
    expect(await cachedObjects(world, documentId)).toHaveLength(1);

    await world.sql`update catalyst_kb.page_cache set expires_at = now() - interval '1 second'`;
    await runExpiry(world);
    expect(await world.sql`select document_id from catalyst_kb.page_cache`).toEqual([]);
    expect(await cachedObjects(world)).toEqual([]);
  });

  it("answers knowledge_source_unreachable when the source is down or holds other bytes, and audits the failure", async () => {
    const source = countedSource();
    const world = await setup(source.wrap);
    const { ids, items } = await synced(world, { "down.txt": "Down page.", "edited.txt": "Old." });
    source.state.down = true;
    await expect(open(world, required(ids["down.txt"]))).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      details: { reason: KNOWLEDGE_SOURCE_UNREACHABLE }
    });
    source.state.down = false;
    // Changed at the source but not synced yet: the indexed version is no longer there.
    world.world.write(required(items["edited.txt"]), encode("New."));
    await expect(open(world, required(ids["edited.txt"]))).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: KNOWLEDGE_SOURCE_UNREACHABLE }
    });
    expect(await world.sql`select document_id from catalyst_kb.page_cache`).toEqual([]);
    expect(await cachedObjects(world)).toEqual([]);
    const events = await fetchEvents(world);
    expect(events.map((event) => [event.status, event.reason])).toEqual([
      ["failed", "source_unavailable"],
      ["failed", "source_not_found"]
    ]);
    expect(JSON.stringify(events)).not.toContain("down.txt");
    // Nothing is withdrawn by an open.
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.documents where withdrawn_at is null`
    ).toEqual([{ n: 2 }]);
  });

  it("never serves a withdrawn document, from the cache either, and its withdrawal purges its entry", async () => {
    const source = countedSource();
    const world = await setup(source.wrap);
    const files = Object.fromEntries(
      ["a", "b", "c", "d"].map((name) => [`${name}.txt`, `Page ${name}.`])
    );
    const { ids, items } = await synced(world, files);
    const withdrawn = required(ids["a.txt"]);
    const kept = required(ids["b.txt"]);
    await open(world, withdrawn);
    await open(world, kept);
    source.state.fetches = 0;

    world.world.remove(required(items["a.txt"]));
    await world.drain(await world.sync("changes"));
    expect(
      await world.sql`select withdrawn_at is not null as withdrawn from catalyst_kb.documents where id=${withdrawn}`
    ).toEqual([{ withdrawn: true }]);
    await expect(open(world, withdrawn)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The cache store itself reads no withdrawn document, whatever reached it.
    const store = required(
      world.dataStores.knowledgeBackend.documentStore({
        backend: "builtin",
        assetId: world.record.id,
        name: KB,
        methods: []
      })?.pageCache
    );
    expect(await store.read(withdrawn)).toBeUndefined();
    expect(source.state.fetches).toBe(0);
    // The withdrawal queued the document's removal, whose purge deletes its cached page.
    const [queued] = await world.platform`update platform_jobs set run_after = now()
      where kind = 'knowledge_base.remove_documents' and status = 'queued' returning id`;
    expect(queued).toBeDefined();
    await world.worker.runDue();
    expect(await world.sql`select document_id from catalyst_kb.page_cache`).toEqual([
      { document_id: kept }
    ]);
    expect(await cachedObjects(world, withdrawn)).toEqual([]);
    expect(await cachedObjects(world, kept)).toHaveLength(1);
    const [purged] = await world.platform`select metadata from audit_events
      where type = 'knowledge_base.documents_purged' and subject = ${world.record.id}`;
    expect(purged?.metadata).toMatchObject({ cachedPages: 1 });
  });

  it("deletes the whole page cache with the Knowledge Base", async () => {
    const world = await setup();
    const { ids } = await synced(world, { "a.txt": "Page a.", "b.txt": "Page b." });
    for (const id of Object.values(ids)) await open(world, id);
    expect(await cachedObjects(world)).toHaveLength(2);
    const deleted = await world.instance.api.call("assets.delete", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { expectedRevision: 2 }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await world.platform`update platform_jobs set run_after = now()
      where kind = 'knowledge_base.remove_documents' and status = 'queued'`;
    await world.worker.runDue();
    expect(await cachedObjects(world)).toEqual([]);
    const [purged] = await world.platform`select metadata from audit_events
      where type = 'knowledge_base.deleted' and subject = ${world.record.id}`;
    expect(purged?.metadata).toMatchObject({ cachedPages: 2 });
  });
});

describe("the page cache's size bound (KB 76)", () => {
  // Three entries of 8 bytes do not fit 20.
  const { setup } = useKnowledgeSync({ pageCacheBytes: 20 });

  it("evicts the oldest fetch first and stays within the bound", async () => {
    const source = countedSource();
    const world = await setup(source.wrap);
    const { ids } = await synced(world, {
      "a.txt": "Page a..",
      "b.txt": "Page b..",
      "c.txt": "Page c.."
    });
    const [a, b, c] = ["a.txt", "b.txt", "c.txt"].map((name) => required(ids[name]));
    for (const id of [a, b, c]) await open(world, required(id));
    expect(
      await world.sql`select document_id from catalyst_kb.page_cache order by cached_at`
    ).toEqual([{ document_id: b }, { document_id: c }]);
    expect(
      await world.sql`select sum(byte_size)::int as bytes from catalyst_kb.page_cache`
    ).toEqual([{ bytes: 16 }]);
    expect(await cachedObjects(world, a)).toEqual([]);
    expect(await cachedObjects(world)).toHaveLength(2);
    source.state.fetches = 0;
    expect(await open(world, required(a))).toBe("Page a..");
    expect(source.state.fetches).toBe(1);
    expect(
      await world.sql`select document_id from catalyst_kb.page_cache order by cached_at`
    ).toEqual([{ document_id: c }, { document_id: a }]);
  });
});

describe("who may open a cited synced page (KB 76)", () => {
  const { setup } = useKnowledgeSync();

  it("refuses a reader without knowledge_base.use before anything is fetched", async () => {
    const source = countedSource();
    const world = await setup(source.wrap, undefined, false, developmentAuth);
    const { ids } = await synced(world, { "a.txt": "Page a." });
    source.state.fetches = 0;
    world.openSource.mockClear();
    const denied = await world.instance.api.call("knowledge_bases.open_document", {
      params: { knowledgeBase: KB, documentId: required(ids["a.txt"]) },
      headers: asMember
    });
    expect(denied.statusCode).toBe(403);
    expect(source.state.fetches).toBe(0);
    expect(world.openSource).not.toHaveBeenCalled();
    expect(await fetchEvents(world)).toEqual([]);
    expect(await world.sql`select document_id from catalyst_kb.page_cache`).toEqual([]);
  });
});
