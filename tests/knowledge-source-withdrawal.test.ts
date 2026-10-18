import { describe, expect, it } from "vitest";
import {
  DocumentSourceError,
  knowledgeExtractionKey,
  asUserId,
  LEGACY_LIST_GRANTOR
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { eventually, required } from "./support/assertions";

// KB 79: the Box staging test is deferred until CS-6 and Felix's developer account are available.
const KB = "sync-test";
const SOURCE = "source";

describe("source changes and withdrawal (SRC-3a, KB 78)", () => {
  const { setup } = useKnowledgeSync();
  const file = (name: string) => ({
    folderId: "folder",
    name,
    mime: "text/plain",
    bytes: new TextEncoder().encode(name)
  });

  it("accepts mode changes over HTTP and applies deletes, edits and renames without refetching unchanged bytes", async () => {
    const fetched: string[] = [];
    const world = await setup((source) => ({
      ...source,
      async *fetch(input, context) {
        fetched.push(input.itemId);
        yield* source.fetch(input, context);
      }
    }));
    const deleted = world.world.put(file("deleted.txt"));
    const edited = world.world.put(file("edited.txt"));
    const renamed = world.world.put(file("renamed.txt"));
    await world.drain(await world.sync());
    fetched.length = 0;
    world.world.remove(deleted);
    world.world.write(edited, new TextEncoder().encode("updated content"));
    world.world.rename(renamed, "new-name.txt");
    const response = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "changes" }
    });
    expect(response.statusCode, response.body).toBe(202);
    const [run] = await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    await world.drain(String(required(run).id));
    expect(fetched).toEqual([edited]);
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${deleted}`
    ).toEqual([{ state: "withdrawn" }]);
    expect(
      await world.sql`select title from catalyst_kb.documents d join catalyst_kb.source_items i on i.document_id=d.id where i.item_id=${renamed}`
    ).toEqual([{ title: "new-name.txt" }]);
    expect(
      await world.sql`select last_change_at is not null as changed, oldest_open_change_at is null as settled from catalyst_kb.source_cursors`
    ).toEqual([{ changed: true, settled: true }]);
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "deleted" }
    });
    expect(hits.statusCode, hits.body).toBe(200);
    expect(hits.body).not.toContain("deleted.txt");
  });

  it("withdraws an item moved outside the folder boundary by the feed", async () => {
    // A feed may report an upsert outside the requested boundary.
    let outside = false;
    const world = await setup((source) => ({
      ...source,
      async changes(input, ctx) {
        const page = await source.changes(input, ctx);
        return page.kind === "changes" && outside
          ? {
              ...page,
              changes: page.changes.map((change) =>
                change.kind === "upsert"
                  ? { ...change, item: { ...change.item, parents: ["outside"] } }
                  : change
              )
            }
          : page;
      }
    }));
    const item = world.world.put(file("moved.txt"));
    await world.drain(await world.sync());
    outside = true;
    world.world.rename(item, "moved-away.txt");
    await world.drain(await world.sync("changes"));
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "withdrawn" }
    ]);
  });

  it.each(["not_found", "forbidden"] as const)(
    "withdraws a fetch answered %s without retrying it",
    async (code) => {
      const world = await setup((source) => ({
        ...source,
        async *fetch() {
          throw new DocumentSourceError(code, "Item unavailable");
        }
      }));
      world.world.put(file("denied.txt"));
      await world.drain(await world.sync());
      expect(await world.sql`select state,attempts from catalyst_kb.source_items`).toEqual([
        { state: "withdrawn", attempts: 0 }
      ]);
      expect(await world.sql`select withdrawn,failed from catalyst_kb.sync_runs`).toEqual([
        { withdrawn: 1, failed: 0 }
      ]);
    }
  );

  it("falls back after an expired cursor, records the reason and reconciles a missed deletion", async () => {
    const world = await setup();
    const ids = Array.from({ length: 5 }, (_, n) => world.world.put(file(`file-${n}.txt`)));
    await world.drain(await world.sync());
    world.world.remove(required(ids[0]));
    world.world.expireCursors();
    const run = await world.sync("changes");
    await world.drain(run);
    expect(
      await world.sql`select mode,reason,withdrawn from catalyst_kb.sync_runs where id=${run}`
    ).toEqual([{ mode: "full", reason: "cursor_expired", withdrawn: 1 }]);
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${required(ids[0])}`
    ).toEqual([{ state: "withdrawn" }]);
  });

  it("reconciles a source without a feed and requires publisher confirmation above 20 percent", async () => {
    const world = await setup((source) => ({
      ...source,
      changes: async () => ({ kind: "not_offered" })
    }));
    const deleted = world.world.put(file("missing.txt"));
    world.world.put(file("kept.txt"));
    await world.drain(await world.sync());
    world.world.remove(deleted);
    const run = await world.sync("changes");
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.source_items order by item_id`).toEqual([
      { state: "fetched" },
      { state: "fetched" }
    ]);
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    const decision = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await world.drain(run);
    await world.worker.runDue();
    expect(
      await world.sql`select state,document_id,purged_at is not null as purged from catalyst_kb.source_items where item_id=${deleted}`
    ).toEqual([{ state: "withdrawn", document_id: null, purged: true }]);
    expect(
      await world.sql`select state,items::int from catalyst_kb.source_counts where items<>0 order by state`
    ).toEqual([
      { state: "indexed", items: 1 },
      { state: "withdrawn", items: 1 }
    ]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 1 }
    ]);
  });

  it.each(["unauthorized", "unavailable"] as const)(
    "a listing failure %s after a page never withdraws missing documents",
    async (code) => {
      let fail = false;
      const world = await setup((source) => ({
        ...source,
        async list(input, ctx) {
          if (!fail) return source.list(input, ctx);
          if (input.pageToken) throw new DocumentSourceError(code, "No provider text");
          return { items: [], nextPageToken: "page-two" };
        }
      }));
      world.world.put(file("safe.txt"));
      await world.drain(await world.sync());
      fail = true;
      const run = await world.sync("full");
      await world.worker.runDue();
      expect(
        await world.sql`select state,failure_code from catalyst_kb.sync_runs where id=${run}`
      ).toEqual([
        {
          state: "failed",
          failure_code:
            code === "unauthorized" ? "knowledge_source_refused" : "knowledge_source_unreachable"
        }
      ]);
      expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
        { state: "fetched" }
      ]);
      expect(await world.sql`select withdrawn_at from catalyst_kb.documents`).toEqual([
        { withdrawn_at: null }
      ]);
    }
  );

  it("purges unshared extraction, chunks and vectors while retaining the withdrawn item for locate", async () => {
    const world = await setup();
    const item = world.world.put(file("purge-secret.txt"));
    await world.drain(await world.sync());
    const [document] = await world.sql`select content_sha256 from catalyst_kb.documents`;
    const extraction = knowledgeExtractionKey(
      world.record.id,
      String(required(document).content_sha256)
    );
    await world.objects.head(extraction);
    world.world.remove(item);
    await world.drain(await world.sync("changes"));
    await world.worker.runDue();
    for (const table of ["documents", "contents", "chunks", "embeddings_1"])
      expect(await world.sql.unsafe(`select count(*)::int as n from catalyst_kb.${table}`)).toEqual(
        [{ n: 0 }]
      );
    await expect(world.objects.head(extraction)).rejects.toThrow();
    expect(
      await world.sql`select state,document_id,purged_at is not null as purged from catalyst_kb.source_items`
    ).toEqual([{ state: "withdrawn", document_id: null, purged: true }]);
  });
  it("publishes narrowing and removal with immediate search exclusion, correct tombstones and grants; re-add starts a new initial run", async () => {
    const world = await setup();
    world.world.put(file("exclude-me.txt"));
    world.world.put(file("keep-me.txt"));
    await world.drain(await world.sync());
    await world.publishSources([
      { id: SOURCE, connection: "fixture", folders: ["folder"], exclude: ["exclude-*"] }
    ]);
    const hidden = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "exclude" }
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.body).not.toContain("exclude-me.txt");
    await world.worker.runDue();
    expect(await world.sql`select name,state from catalyst_kb.source_items order by name`).toEqual([
      { name: "exclude-me.txt", state: "withdrawn" },
      { name: "keep-me.txt", state: "fetched" }
    ]);
    await world.publishSources([]);
    const removed = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "keep" }
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.body).not.toContain("keep-me.txt");
    await world.worker.runDue();
    await world.worker.runDue();
    expect(
      await world.sql`select state,document_id,purged_at is not null as purged from catalyst_kb.source_items order by item_id`
    ).toEqual([
      { state: "withdrawn", document_id: null, purged: true },
      { state: "withdrawn", document_id: null, purged: true }
    ]);
    expect(
      await world.platform`select count(*)::int as n from permission_grants g join service_principals p on p.id=g.holder_id where p.owner_asset_id=${world.record.id} and g.action='connection.use'`
    ).toEqual([{ n: 0 }]);
    await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["folder"] }]);
    await world.worker.runDue();
    const [initial] =
      await world.sql`select id from catalyst_kb.sync_runs where mode='initial' and id<>'sync-1'`;
    await world.drain(String(required(initial).id));
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.documents where withdrawn_at is null`
    ).toEqual([{ n: 2 }]);
    expect(
      await world.sql`select state,items::int from catalyst_kb.source_counts where items<>0`
    ).toEqual([{ state: "indexed", items: 2 }]);
  });

  it("keeps page effects and cursor atomic when withdrawal fails", async () => {
    const world = await setup();
    const item = world.world.put(file("atomic.txt"));
    await world.drain(await world.sync());
    const before = await world.sql`select cursor from catalyst_kb.source_cursors`;
    await world.sql
      .unsafe(`create function reject_withdrawal() returns trigger language plpgsql as $$ begin if new.state='withdrawn' then raise exception 'injected'; end if; return new; end $$;
      create trigger reject_withdrawal before update on catalyst_kb.source_items for each row execute function reject_withdrawal()`);
    world.world.remove(item);
    await world.sync("changes");
    await world.worker.runDue();
    expect(await world.sql`select cursor from catalyst_kb.source_cursors`).toEqual(before);
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "fetched" }
    ]);
    expect(await world.sql`select withdrawn_at from catalyst_kb.documents`).toEqual([
      { withdrawn_at: null }
    ]);
    await world.sql.unsafe(
      "drop trigger reject_withdrawal on catalyst_kb.source_items; drop function reject_withdrawal()"
    );
    await world.drain(await world.sync("changes"));
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "withdrawn" }
    ]);
  });
  it("requires publish on this Knowledge Base for a mass withdrawal and rejection leaves every document searchable", async () => {
    const world = await setup(undefined, undefined, false, {
      enabled: true,
      users: [
        {
          id: "owner",
          externalUserId: "owner",
          displayLabel: "Owner",
          roles: ["superadmin"],
          permissionRefs: []
        },
        {
          id: "reader",
          externalUserId: "reader",
          displayLabel: "Reader",
          roles: ["user"],
          permissionRefs: []
        }
      ],
      defaultUserId: "owner"
    });
    const item = world.world.put(file("retained.txt"));
    await world.drain(await world.sync());
    world.world.remove(item);
    const run = await world.sync("full");
    await world.worker.runDue();
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    const me = await world.instance.api.call("me.get", {}, "reader");
    expect(me.statusCode, me.body).toBe(200);
    const reader = me.json<{ id: string }>().id;
    const grant = async (action: string, scopeId: string) =>
      world.instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: reader,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId,
        grantedBy: asUserId(LEGACY_LIST_GRANTOR)
      });
    await grant("knowledge_base.read", world.record.id);
    const decide = () =>
      world.instance.api.call(
        "approval_requests.decide",
        { params: { requestId: request.id }, payload: { decision: "reject" } },
        "reader"
      );
    expect((await decide()).statusCode).toBe(404);
    const another = await world.instance.api.call("assets.put", {
      params: { kind: "knowledge_base", name: "another-kb" },
      payload: {
        config: {
          name: "another-kb",
          title: "Another",
          description: "Different grant scope",
          methods: ["keyword"]
        },
        expectedRevision: null
      }
    });
    expect(another.statusCode, another.body).toBe(200);
    const otherAsset = required(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "knowledge_base",
        name: "another-kb"
      })
    );
    await grant("knowledge_base.publish", otherAsset.id);
    expect((await decide()).statusCode).toBe(404);
    await grant("knowledge_base.publish", world.record.id);
    const rejected = await decide();
    expect(rejected.statusCode, rejected.body).toBe(200);
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.sync_runs where id=${run}`).toEqual([
      { state: "failed" }
    ]);
    expect(await world.sql`select withdrawn_at from catalyst_kb.documents`).toEqual([
      { withdrawn_at: null }
    ]);
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "retained" }
    });
    expect(hits.body).toContain("retained.txt");
  });

  it("KB 78 / SRC-3b: a later pass supersedes pending withdrawal confirmation when items reappear", async () => {
    let missing = false;
    const world = await setup((source) => ({
      ...source,
      async list(input, context) {
        const page = await source.list(input, context);
        return missing ? { ...page, items: [] } : page;
      }
    }));
    world.world.put(file("rediscovered.txt"));
    await world.drain(await world.sync());
    missing = true;
    const waiting = await world.sync("full");
    await world.worker.runDue();
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    missing = false;
    // The stable sync operation must start a fresh pass instead of joining the held run.
    const response = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, mode: "full" }
    });
    expect(response.statusCode, response.body).toBe(202);
    const [replacement] =
      await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    expect(replacement?.id).not.toBe(waiting);
    expect(
      await world.sql`select state,failure_code from catalyst_kb.sync_runs where id=${waiting}`
    ).toEqual([{ state: "superseded", failure_code: null }]);
    await world.drain(String(required(replacement).id));
    expect(
      await world.instance.stores.approvals.getApprovalRequest({
        clientInstanceId,
        requestId: request.id
      })
    ).toMatchObject({ status: "superseded" });
    const pending = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    expect(pending.json<{ items: { id: string }[] }>().items).toEqual([]);
    const stale = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "approve" }
    });
    expect(stale.statusCode).toBe(409);
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "fetched" }
    ]);
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "rediscovered" }
    });
    expect(hits.body).toContain("rediscovered.txt");
  });

  it("a full pass catches a deletion that the feed never reports", async () => {
    const world = await setup((source) => ({
      ...source,
      async changes(input, context) {
        const page = await source.changes(input, context);
        return page.kind === "changes"
          ? { ...page, changes: page.changes.filter((change) => change.kind !== "delete") }
          : page;
      }
    }));
    const ids = Array.from({ length: 5 }, (_, n) => world.world.put(file(`missed-${n}.txt`)));
    await world.drain(await world.sync());
    world.world.remove(required(ids[0]));
    await world.drain(await world.sync("changes"));
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${required(ids[0])}`
    ).toEqual([{ state: "fetched" }]);
    await world.drain(await world.sync("full"));
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${required(ids[0])}`
    ).toEqual([{ state: "withdrawn" }]);
  });
  it("a new pass reclaims a discovered item left by a failed earlier fetch", async () => {
    const world = await setup();
    world.world.put(file("recovered.txt"));
    const failed = await world.sync();
    await world.worker.runDue();
    await world.sql`update catalyst_kb.sync_runs set state='failed',failure_code='knowledge_source_refused',ended_at=now() where id=${failed}`;
    await world.sql`update catalyst_kb.source_items set fetch_job_id='lost-old-fetch'`;
    await world.drain(await world.sync("full"));
    expect(await world.sql`select state,attempts from catalyst_kb.source_items`).toEqual([
      { state: "fetched", attempts: 1 }
    ]);
  });

  it("supersedes a pending withdrawal confirmation when the published source boundary changes", async () => {
    const world = await setup();
    const item = world.world.put(file("stale-confirmation.txt"));
    await world.drain(await world.sync());
    world.world.remove(item);
    await world.sync("full");
    await world.worker.runDue();
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["other"] }]);
    const decision = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    expect(decision.json()).toMatchObject({ status: "superseded" });
    // The publish's reconciliation is queued, but the old approval applies nothing.
    expect(await world.sql`select withdrawn_at from catalyst_kb.documents`).toEqual([
      { withdrawn_at: null }
    ]);
  });
  it("reconciles more than one withdrawal page and queues bounded purge batches", async () => {
    const world = await setup();
    const ids = Array.from({ length: 101 }, (_, n) =>
      world.world.put({
        ...file(`batch-${n}.txt`),
        bytes: new TextEncoder().encode("shared content")
      })
    );
    await world.drain(await world.sync());
    for (const id of ids) world.world.remove(id);
    const run = await world.sync("full");
    await world.worker.runDue();
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    const decision = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await world.drain(run);
    expect(await world.sql`select withdrawn from catalyst_kb.sync_runs where id=${run}`).toEqual([
      { withdrawn: 101 }
    ]);
    expect(
      await world.platform`select jsonb_array_length(payload->'documentIds') as n from platform_jobs where kind='knowledge_base.remove_documents' order by n`
    ).toEqual([{ n: 1 }, { n: 100 }]);
    await eventually(async () => {
      await world.worker.runDue();
      expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
        { n: 0 }
      ]);
    });
    expect(
      await world.sql`select state,items::int from catalyst_kb.source_counts where items>0`
    ).toEqual([{ state: "withdrawn", items: 101 }]);
  }, 180000);

  it("honours rejection even if an item fetch reduces the remaining withdrawal share", async () => {
    const world = await setup();
    const ids = Array.from({ length: 6 }, (_, n) => world.world.put(file(`decision-${n}.txt`)));
    await world.drain(await world.sync());
    world.world.remove(required(ids[0]));
    world.world.remove(required(ids[1]));
    const run = await world.sync("full");
    await world.worker.runDue();
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    const [item] =
      await world.sql`select id,document_id from catalyst_kb.source_items where item_id=${required(ids[0])}`;
    await world.sql`update catalyst_kb.contents set state='failed',failure_code='knowledge_index_failed' where sha256=(select content_sha256 from catalyst_kb.documents where id=${String(required(item).document_id)})`;
    const retry = await world.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, sourceItemIds: [String(required(item).id)] }
    });
    expect(retry.statusCode, retry.body).toBe(200);
    await world.worker.runDue();
    // The fetch's authoritative 404 withdraws one item. The remaining full-listing
    // candidate is now exactly 20% of the source, but its pending decision still owns it.
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${required(ids[0])}`
    ).toEqual([{ state: "withdrawn" }]);
    const decision = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "reject" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.sync_runs where id=${run}`).toEqual([
      { state: "failed" }
    ]);
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${required(ids[1])}`
    ).toEqual([{ state: "fetched" }]);
  });
  it("a confirmation approved before a boundary change cannot execute against the newer definition", async () => {
    const world = await setup();
    const item = world.world.put(file("queued-decision.txt"));
    await world.drain(await world.sync());
    world.world.remove(item);
    const run = await world.sync("full");
    await world.worker.runDue();
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    const request = required(inbox.json<{ items: { id: string }[] }>().items[0]);
    const decision = await world.instance.api.call("approval_requests.decide", {
      params: { requestId: request.id },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["other"] }]);
    await world.platform`update platform_jobs set run_after=now()+interval '1 day' where kind='knowledge_base.reconcile_sources' and status='queued'`;
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.sync_runs where id=${run}`).toEqual([
      { state: "superseded" }
    ]);
    expect(await world.sql`select withdrawn_at from catalyst_kb.documents`).toEqual([
      { withdrawn_at: null }
    ]);
  });

  it("bootstraps the widened boundary instead of reusing its old change cursor", async () => {
    const world = await setup();
    await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["folder"] }]);
    world.world.put(file("inside.txt"));
    world.world.put({ ...file("newly-included.txt"), folderId: "other" });
    await world.drain(await world.sync());
    expect(await world.sql`select count(*)::int as n from catalyst_kb.source_items`).toEqual([
      { n: 1 }
    ]);
    await world.publishSources([
      { id: SOURCE, connection: "fixture", folders: ["folder", "other"] }
    ]);
    await world.drain(await world.sync("changes"));
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.source_items where state='fetched'`
    ).toEqual([{ n: 2 }]);
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "newly" }
    });
    expect(hits.body).toContain("newly-included.txt");
  });

  it("a boundary publication only reconciles the changed source", async () => {
    const world = await setup();
    world.world.put(file("first.txt"));
    world.world.put({ ...file("second.txt"), folderId: "other" });
    await world.drain(await world.sync());
    const second = { id: "second", connection: "fixture", folders: ["other"] };
    await world.publishSources([
      { id: SOURCE, connection: "fixture", folders: ["folder", "other"] },
      second
    ]);
    await world.worker.runDue();
    const [run] = await world.sql`select id from catalyst_kb.sync_runs where source_id='second'`;
    await world.drain(String(required(run).id));
    // A second source upgraded from SRC-1b may not have parent metadata until its full pass.
    await world.sql`update catalyst_kb.source_items set parents='[]'::jsonb where source_id='second'`;
    await world.publishSources([
      { id: SOURCE, connection: "fixture", folders: ["folder", "other"], exclude: ["*.txt"] },
      second
    ]);
    await world.worker.runDue();
    expect(
      await world.sql`select state from catalyst_kb.source_items where source_id='second'`
    ).toEqual([{ state: "fetched" }]);
    expect(
      await world.sql`select state from catalyst_kb.source_items where source_id=${SOURCE}`
    ).toEqual([{ state: "withdrawn" }, { state: "withdrawn" }]);
  });
});
