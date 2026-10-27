import { describe, expect, it } from "vitest";
import { createJobWorker, createLogger } from "@work-shape/catalyst-client-assembly";
import {
  createActorAccess,
  DATA_STORE_JOB_KINDS,
  KNOWLEDGE_BASE_ASSET_KIND
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { knowledgePublisher, useKnowledgeSync } from "./support/knowledge-sync";

describe("reading sources immediately after publishing a Knowledge Base", () => {
  const { start } = useDataStoreInstance();

  it("answers the published empty source list before the owned store is provisioned", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    const name = "freshly-published";
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name };
    const created = await instance.api.call("assets.put", {
      params,
      payload: {
        expectedRevision: null,
        config: {
          name,
          title: "Freshly published",
          description: "Documents added by hand.",
          methods: ["keyword"]
        }
      }
    });
    expect(created.statusCode, created.body).toBe(200);
    const published = await instance.api.call("assets.publish", {
      params,
      payload: { revision: 1 }
    });
    expect(published.statusCode, published.body).toBe(200);

    // No jobs run between publish and GET: keep the reported window open deterministically.
    const sources = await instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: name }
    });
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json()).toEqual({ sources: [] });
    expect(
      await instance.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${name}`
      })
    ).toMatchObject({ status: "provisioning" });
  });
});

describe("reading connector sources during initial provisioning", () => {
  const { setup } = useKnowledgeSync();

  it("answers published sources with no items or runs yet, and excludes a later draft", async () => {
    const world = await setup();
    const name = "fresh-with-source";
    const config = {
      name,
      title: "Fresh with source",
      description: "Documents from a connector.",
      methods: ["keyword"],
      sources: [{ id: "source", connection: "fixture", folders: ["folder"] }]
    };
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name };
    const created = await world.instance.api.call("assets.put", {
      params,
      payload: { expectedRevision: null, config }
    });
    expect(created.statusCode, created.body).toBe(200);
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        ...params
      })
    );
    const revision = required(
      await world.instance.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        ...params,
        revision: 1
      })
    );
    const access = createActorAccess(
      {
        clientInstanceId,
        kind: "user",
        id: "publisher",
        roles: ["superadmin"],
        permissionRefs: []
      },
      { holderActive: true, grants: [] }
    );
    // The fixture connector is offered by the source engine, outside the API's registry.
    await world.instance.stores.transaction(async (stores) => {
      await world.knowledge.publish(stores, {
        access,
        actor: knowledgePublisher,
        assetId: asset.id,
        revision: 1,
        config,
        replaced: undefined
      });
      await stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        ...params,
        assetId: asset.id,
        revision: 1,
        revisionId: revision.id
      });
    });

    const expected = {
      sources: [
        {
          id: "source",
          connection: "fixture",
          items: { discovered: 0, fetched: 0, indexed: 0, failed: 0, withdrawn: 0 },
          failures: []
        }
      ]
    };
    const read = () =>
      world.instance.api.call("knowledge_bases.sources", {
        params: { knowledgeBase: name }
      });
    const sources = await read();
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json()).toEqual(expected);
    const draft = await world.instance.api.call("assets.put", {
      params,
      payload: { expectedRevision: 1, config: { ...config, sources: [] } }
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const afterDraft = await read();
    expect(afterDraft.statusCode, afterDraft.body).toBe(200);
    expect(afterDraft.json()).toEqual(expected);
    expect(
      await world.instance.stores.dataStores.getDataStore({ clientInstanceId, id: asset.id })
    ).toMatchObject({ status: "provisioning" });
    // Provisioning the database and installing the Knowledge Base tables are separate jobs.
    const provisioner = createJobWorker({
      clientInstanceId,
      stores: world.instance.stores,
      handlers: world.dataStores.jobHandlers.filter(
        (handler) => handler.kind.kind === DATA_STORE_JOB_KINDS.provision
      ),
      logger: createLogger()
    });
    try {
      await provisioner.runDue();
    } finally {
      await provisioner.stop();
    }
    const record = required(
      await world.instance.stores.dataStores.getDataStore({
        clientInstanceId,
        id: asset.id
      })
    );
    expect(record).toMatchObject({ status: "ready", level: 0, migrations: [] });
    const beforeTables = await read();
    expect(beforeTables.statusCode, beforeTables.body).toBe(200);
    expect(beforeTables.json()).toEqual(expected);
    // A failed job is different from the normal preparation window: keep that error visible.
    await world.instance.stores.dataStores.putDataStore({
      ...record,
      status: "provisioning",
      failure: { code: "provisioning_failed", message: "The database could not be created" }
    });
    expect((await read()).statusCode).toBe(409);
  });
});
