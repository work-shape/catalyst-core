import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  createActorAccess,
  createPlatformId,
  NoopAuditRecorder,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { clientInstanceId } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { eventually, required } from "./support/assertions";

describe("REC-ELIG source visibility at proposal admission", () => {
  const { setup } = useKnowledgeSync({ withDataStoreJobs: true });

  it("skips a narrowed document before cleanup and after purge while search and a visible proposal still agree", async () => {
    const world = await setup(undefined, undefined, false, undefined, undefined, "en");
    for (const name of ["hidden.txt", "visible.txt"])
      world.world.put({
        folderId: "folder",
        name,
        mime: "text/plain",
        bytes: new TextEncoder().encode(`${name} price 100`)
      });
    await world.drain(await world.sync());
    const config = world.dataStores.readFiles([
      {
        path: "store.yaml",
        bytes: new TextEncoder().encode(
          'id: review\nname: Review\nrecords:\n  - table: readings\n    key: { column: id, fromPath: "/cases/{id}/" }\n    precedence: []\n    review: { always: [] }\n'
        )
      },
      {
        path: "migrations/0001_readings.sql",
        bytes: new TextEncoder().encode(
          "create table readings(id integer primary key, amount numeric);"
        )
      }
    ]);
    const stores = world.instance.stores;
    const written = await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "data_store:review": null },
      mutations: [{ type: "upsert", kind: "data_store", name: "review", config, draft: true }]
    });
    const assetId = required(written.assetIds["data_store:review"]);
    const revision = required(written.revisions["data_store:review"]);
    const saved = required(
      await stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: "data_store",
        name: "review",
        revision
      })
    );
    await stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: "data_store",
      name: "review",
      assetId,
      revision,
      revisionId: saved.id
    });
    await world.dataStores.publish(stores, { assetId, revision, config });
    const record = await eventually(async () => {
      await world.worker.runDue();
      const record = required(
        await stores.dataStores.getDataStore({ clientInstanceId, id: assetId })
      );
      expect(record.status).toBe("ready");
      expect(record.level).toBe(1);
      return record;
    });
    const docs = await world.sql<
      { id: string; file_name: string }[]
    >`select id,file_name from catalyst_kb.documents`;
    const items = ["hidden.txt", "visible.txt"].map((name, n) => ({
      knowledgeBaseId: world.record.id,
      documentId: required(docs.find((doc) => doc.file_name === name)).id,
      kind: "default",
      documentDate: "2026-10-18",
      path: `/cases/${n + 1}/`,
      fields: [{ name: "amount", value: 100, page: 1, quote: "100" }]
    }));
    const actor = {
      clientInstanceId,
      id: "publisher",
      externalUserId: "publisher",
      displayLabel: "Publisher",
      authSource: "test",
      roles: ["superadmin"],
      permissionRefs: []
    };
    const access = createActorAccess(
      { ...actor, kind: "user" },
      { holderActive: true, grants: [] }
    );
    const propose = required(
      await world.dataStores.operationSource.resolve("data_store.review.records.propose")
    );
    const context = (): OperationExecutionContext => ({
      runId: createPlatformId("opr"),
      actor,
      origin: {
        kind: "workflow",
        workflowRunId: "visibility",
        stepRunId: createPlatformId("step")
      },
      correlationId: "visibility",
      runtime: { locale: "en" },
      access,
      audit: new NoopAuditRecorder()
    });
    await world.publishSources([
      { id: "source", connection: "fixture", folders: ["folder"], exclude: ["hidden*"] }
    ]);
    // Publish has committed; the source-policy job has not run yet.
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.documents where withdrawn_at is null`
    ).toEqual([{ n: 2 }]);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const target = postgres(url.toString(), { max: 1, onnotice() {} });
    try {
      for (const phase of ["pending cleanup", "purged"]) {
        const search = await world.instance.api.call("knowledge_bases.search", {
          params: { knowledgeBase: "sync-test" },
          payload: { query: "price" }
        });
        expect(search.statusCode).toBe(200);
        expect(search.body).not.toContain("hidden.txt");
        expect(search.body).toContain("visible.txt");
        const result = await propose.execute({ table: "readings", items }, context());
        expect(result, phase).toMatchObject({ done: 1, failed: 1, failures: { rowCount: 1 } });
        expect(world.recordFailures.at(-1)).toMatchObject([
          {
            code: "record_document_unavailable",
            message: expect.stringContaining("published source boundary")
          }
        ]);
        expect(await target`select id,amount::float8 from readings`).toEqual([
          { id: 2, amount: 100 }
        ]);
        expect(await target`select distinct document_id from catalyst.record_fields`).toEqual([
          { document_id: required(items[1]).documentId }
        ]);
        if (phase === "pending cleanup")
          await eventually(async () => {
            await world.worker.runDue();
            expect(
              await world.sql`select count(*)::int as n from catalyst_kb.source_items where state='withdrawn' and purged_at is not null`
            ).toEqual([{ n: 1 }]);
          });
      }
    } finally {
      await target.end();
    }
  });
});
