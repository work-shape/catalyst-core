import { createHash } from "node:crypto";
import type {
  AuthenticatedUser,
  JsonObject,
  OperationBatchFailure
} from "@work-shape/catalyst-core";
import { accessOf } from "./access";
import { required } from "./assertions";
import { manifest, type StoreFile, type useDataStoreWorld } from "./data-store-world";

// A store with a records rule over `objekt`, filled from the documents of a Knowledge Base the
// test publishes beside it: the world of the records tests (REC-1a, REC-2).

export const objektSchema: StoreFile = {
  path: "migrations/0001_objects.sql",
  text: "create table objekt (objekt_nr integer primary key, adresse text, baujahr integer, kaufpreis numeric, wohnflaeche numeric);"
};

export const objektRecords = (key = 'fromPath: "/Objekte/{objekt_nr}/"', always = "[]") =>
  manifest(
    `records:\n  - table: objekt\n    key: { column: objekt_nr, ${key} }\n    precedence: [kaufvertrag, baubeschreibung, expose]\n    review: { always: ${always} }\n`
  );

export const recordsActorOf = (
  clientInstanceId: AuthenticatedUser["clientInstanceId"]
): AuthenticatedUser => ({
  id: "records-admin",
  externalUserId: "records-admin",
  displayLabel: "Records admin",
  roles: ["admin"],
  permissionRefs: [],
  authSource: "test",
  clientInstanceId
});

export function recordsWorlds(dataStoreWorld: ReturnType<typeof useDataStoreWorld>) {
  const { db, setup, publish, settle, connect, recordOf } = dataStoreWorld;
  type Ready = Awaited<ReturnType<typeof setup>>;

  /** Writes and publishes an asset of any kind, as the asset workflow does. */
  async function asset(world: Ready, kind: string, name: string, config: JsonObject) {
    const key = `${kind}:${name}`;
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: world.clientInstanceId,
      baseRevisions: { [key]: null },
      mutations: [{ type: "upsert", kind, name, config, draft: true }]
    });
    const revision = required(written.revisions[key]);
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId: world.clientInstanceId,
        kind,
        name,
        revision
      })
    );
    const id = required(written.assetIds[key]);
    await db.store.configAssets.publishConfigAssetRevision({
      clientInstanceId: world.clientInstanceId,
      kind,
      name,
      assetId: id,
      revision,
      revisionId: stored.id
    });
    return id;
  }

  /**
   * The store `findings` with the files, beside the Knowledge Base `unterlagen` whose documents
   * `item` writes and turns into a proposal item.
   */
  async function world(
    label: string,
    files = [objektRecords(), objektSchema],
    load?: { rows: number; bytes: number; timeoutMs: number },
    datasets?: { read(): AsyncIterable<readonly JsonObject[]> },
    databaseUrl = db.databaseUrl
  ) {
    const failures: OperationBatchFailure[][] = [];
    const ready = await setup(label, load ? { load } : {}, databaseUrl, datasets, {
      write: async (items) => {
        failures.push([...items]);
        return {
          $dataset: `failures_${failures.length}`,
          rowCount: items.length,
          bytes: JSON.stringify(items).length
        };
      }
    });
    const id = await publish(ready, files);
    const world = { ...ready, id, record: await settle(ready, id, files.length - 1) };
    /**
     * A Knowledge Base beside the store, published and ready, with `item`, which writes one of
     * its documents and turns it into a proposal item.
     */
    async function knowledgeBase(name: string, title: string) {
      const kbId = await asset(world, "knowledge_base", name, {
        name,
        title,
        description: "Test documents",
        methods: ["keyword"]
      });
      await world.dataStores.knowledgeBackend.publish(db.store, {
        target: { backend: "builtin", assetId: kbId, name, methods: ["keyword"] },
        replaced: undefined,
        access: accessOf(recordsActorOf(world.clientInstanceId))
      });
      await settle(world, kbId, 16);
      const source = connect((await recordOf(world, kbId)).location.database);
      async function item(
        documentId: string,
        kind: string,
        values: JsonObject,
        date = "2026-10-17",
        path = "/Objekte/1402/file.pdf"
      ) {
        const hash = createHash("sha256").update(documentId).digest("hex");
        const text = Object.values(values).join(" ");
        await source`insert into catalyst_kb.contents(sha256,format,state) values (${hash},'pdf','extracted') on conflict do nothing`;
        await source`insert into catalyst_kb.documents(id,managed_file_id,content_sha256,title,file_name) values (${documentId},${documentId},${hash},'Document',${`${documentId}.pdf`}) on conflict do nothing`;
        await source`insert into catalyst_kb.chunks(id,content_sha256,chunking_revision,position,page,text,token_count) values (${documentId},${hash},1,0,1,${text},10) on conflict do nothing`;
        return {
          knowledgeBaseId: kbId,
          documentId,
          kind,
          documentDate: date,
          path,
          fields: Object.entries(values).map(([name, value]) => ({
            name,
            value,
            page: 1,
            quote: String(value)
          }))
        };
      }
      return { kbId, source, item };
    }
    const { kbId, source, item } = await knowledgeBase("unterlagen", "Objektunterlagen");
    const target = connect(world.record.location.database);
    return { ...world, failures, kbId, source, target, item, knowledgeBase };
  }

  return { asset, world };
}
