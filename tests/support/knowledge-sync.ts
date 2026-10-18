import { createManagedObjectTestAttachmentCapability } from "./chat-server-attachment-harness";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterEach, expect, vi } from "vitest";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createFixtureDocumentSource, loadSecretKeyring } from "@work-shape/catalyst-connections";
import { createDataStores, createKnowledgeBases } from "@work-shape/catalyst-data-stores";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import {
  asUserId,
  LEGACY_LIST_GRANTOR,
  defineKnowledgeExtractHandler,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_TEXT_FORMATS,
  type KnowledgeExtractor,
  StoreBackedAuditRecorder,
  KNOWLEDGE_BASE_ASSET_KIND,
  type ConnectorContext,
  type DocumentSourceCapability,
  type KnowledgeFiles,
  type Logger,
  type LocaleCode,
  type OperationBatchFailure
} from "@work-shape/catalyst-core";
import { eventually, required } from "./assertions";
import { clientInstanceId, useDataStoreInstance } from "./data-store-instance";
import { fileTestDatabaseUrl } from "./test-database";
import { getTestJobs } from "./test-instance";
const KB = "sync-test";
const SOURCE = "source";
const target = {
  protocol: "https",
  host: "fixture.invalid",
  port: 443,
  address: "192.0.2.1",
  family: 4,
  network: "public"
} as const;
function context(signal: AbortSignal): ConnectorContext {
  return {
    connection: {
      id: "fixture",
      name: "fixture",
      revision: 1,
      settings: {},
      authScheme: "bearer",
      operations: []
    },
    target,
    checkEgress: async () => target,
    credentialFor: () => ({ scheme: "bearer", secret: "test", headers: {} }),
    signal
  };
}

// Opt in only when a test publishes stores: migration claims otherwise add unrelated transactions.
export function useKnowledgeSync({ withDataStoreJobs = false } = {}) {
  const { start } = useDataStoreInstance();
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  async function setup(
    wrap: (source: DocumentSourceCapability) => DocumentSourceCapability = (source) => source,
    extractor?: KnowledgeExtractor,
    withFileRoute = false,
    developmentAuth?: unknown,
    fieldExtractor?: import("@work-shape/catalyst-core").KnowledgeFieldExtractor,
    defaultLocale: LocaleCode = "de"
  ) {
    const logs: unknown[] = [];
    const logger: Logger = {
      debug: (...data) => {
        logs.push(data);
      },
      info: (...data) => {
        logs.push(data);
      },
      warn: (...data) => {
        logs.push(data);
      },
      error: (...data) => {
        logs.push(data);
      },
      child: () => logger
    };
    const instance = await start(true, undefined, developmentAuth, undefined, {
      embedding: true,
      defaultLocale,
      apiAccess: true,
      ...(extractor ? { documents: true as const } : {}),
      ...(fieldExtractor
        ? {
            attachments: {
              name: "fake-field-binding",
              create: () => ({ knowledgeFieldExtractor: fieldExtractor })
            }
          }
        : {}),
      ...(withFileRoute
        ? { attachments: createManagedObjectTestAttachmentCapability().capability }
        : {})
    });
    const definition = {
      name: KB,
      title: "Source",
      description: "Synced test documents",
      methods: ["keyword", "semantic"]
    };
    expect(
      (
        await instance.api.call("assets.put", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
          payload: { config: definition, expectedRevision: null }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await instance.api.call("assets.publish", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
          payload: { revision: 1 }
        })
      ).statusCode
    ).toBe(200);
    const jobs = getTestJobs(instance.api);
    const record = await eventually(async () => {
      await jobs.runDue();
      const row = await instance.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(row?.status).toBe("ready");
      expect(row?.level).toBe(12);
      return required(row);
    });
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    cleanups.push(() => sql.end());
    const platform = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    cleanups.push(() => platform.end());
    await instance.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "connection:fixture": null },
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "fixture",
          config: { name: "fixture", connectorType: "fixture", enabled: true }
        }
      ]
    });
    const connection = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "fixture"
      })
    );
    const principal = await instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Sync",
      owner: { kind: "knowledge_base", assetId: record.id }
    });
    await instance.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: connection.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });
    // The source engine fixture publishes directly; publish authorization has its own tests.
    expect(
      (
        await instance.api.call("assets.put", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
          payload: {
            config: {
              ...definition,
              sources: [{ id: SOURCE, connection: "fixture", folders: ["folder", "other"] }]
            },
            expectedRevision: 1
          }
        })
      ).statusCode
    ).toBe(200);
    const revision = required(
      await instance.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB,
        revision: 2
      })
    );
    await instance.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: KNOWLEDGE_BASE_ASSET_KIND,
      name: KB,
      assetId: record.id,
      revision: 2,
      revisionId: revision.id
    });
    const fixture = createFixtureDocumentSource({ secret: "test", pageSize: 100 });
    const capability = wrap(fixture.capability);
    const objects = createFilesystemObjectStorage(instance.filesRoot);
    const files: KnowledgeFiles = { objects, open: async () => undefined };
    const embedding = {
      defaultBinding: "embedding",
      processingPrices: [{ bindingId: "embedding", currency: "USD", perMillionTokens: 1 }],
      models: [{ bindingId: "embedding", model: "test", dimensions: 8 }]
    };
    const recordFailures: OperationBatchFailure[][] = [];
    const dataStores = createDataStores({
      defaultLocale,
      embedding,
      clientInstanceId,
      stores: instance.stores,
      databaseUrl: await fileTestDatabaseUrl(),
      keyring: await loadSecretKeyring({
        keys: [{ id: "test", ref: "test" }],
        secrets: { resolve: async () => randomBytes(32).toString("base64") }
      }),
      limits: { sizeLimitBytes: 1024 ** 3, poolMaxConnections: 3 },
      recordFailures: {
        write: async (items) => {
          recordFailures.push([...items]);
          return {
            $dataset: "proc2-failures",
            rowCount: items.length,
            bytes: JSON.stringify(items).length
          };
        }
      },
      logger
    });
    cleanups.push(() => dataStores.close());
    const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
      vectors: texts.map(() => Array.from({ length: 8 }, () => 0.25))
    }));
    const knowledge = createKnowledgeBases({
      defaultLocale,
      assertFieldBudgetPriced: () => fieldExtractor?.assertBudgetPriced?.(),
      clientInstanceId,
      stores: instance.stores,
      backend: dataStores.knowledgeBackend,
      sources: dataStores.knowledgeSources,
      embedding,
      documentFormats: extractor ? KNOWLEDGE_DOCUMENT_FORMATS : KNOWLEDGE_TEXT_FORMATS,
      maxDocuments: 10000,
      logger
    });
    const fileJobs = knowledge.fileJobs(
      files,
      new StoreBackedAuditRecorder({ clientInstanceId, store: instance.stores.audit }),
      embed
    );
    const openSource = vi.fn(async (_name: string, signal: AbortSignal) => ({
      capability,
      context: context(signal)
    }));
    const handlers = dataStores.knowledgeSourceJobs({
      files,
      documentFormats: extractor ? KNOWLEDGE_DOCUMENT_FORMATS : KNOWLEDGE_TEXT_FORMATS,
      maxDocuments: 10000,
      openSource
    });
    const worker = createJobWorker({
      clientInstanceId,
      stores: instance.stores,
      handlers: [
        ...handlers,
        ...(withDataStoreJobs ? dataStores.jobHandlers : []),
        ...fileJobs.handlers,
        ...(extractor
          ? [
              defineKnowledgeExtractHandler({
                clientInstanceId,
                objects,
                extractor,
                maxPages: 500,
                slots: 1
              })
            ]
          : [])
      ],
      logger
    });
    cleanups.push(() => worker.stop());
    let runNumber = 0;
    async function sync(mode: "initial" | "full" | "changes" = "initial") {
      const syncRunId = `sync-${++runNumber}`;
      await dataStores.knowledgeSources.start(
        { knowledgeBaseId: record.id, sourceId: SOURCE, syncRunId, operationRunId: "operation" },
        mode,
        new AbortController().signal
      );
      return syncRunId;
    }
    async function drain(run: string) {
      return vi.waitFor(
        async () => {
          // Advance only this test's scheduled retries, without depending on wall-clock sleeps.
          await platform`update platform_jobs set run_after = now() where status = 'queued' and kind in ('knowledge_base.sync', 'knowledge_base.fetch')`;
          await worker.runDue();
          const [pending] =
            await sql`select count(*)::int as n from catalyst_kb.source_items where state = 'discovered'`;
          const [runRow] = await sql`select state from catalyst_kb.sync_runs where id = ${run}`;
          expect(pending?.n).toBe(0);
          expect(runRow?.state).toBe("done");
          const [unindexed] =
            await sql`select count(*)::int as n from catalyst_kb.contents where state = 'pending'`;
          expect(unindexed?.n).toBe(0);
          // KB-13a: a synced original's release and deletion finish before the run counts as drained.
          const [releasing] =
            await platform`select count(*)::int as n from platform_jobs where kind in ('knowledge_base.delete_originals','knowledge_base.release_originals') and status in ('queued','running')`;
          expect(releasing?.n).toBe(0);
        },
        { timeout: 180_000 }
      );
    }
    async function publishSources(
      sources: {
        id: string;
        connection: string;
        folders: string[];
        include?: string[];
        exclude?: string[];
      }[],
      extra: { extraction?: { budget: { perMonth?: number; maxTokensPerDocument: number } } } = {}
    ) {
      const asset = required(
        await instance.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: KB
        })
      );
      const config = { ...definition, sources, ...extra };
      const put = await instance.api.call("assets.put", {
        params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
        payload: { config, expectedRevision: asset.revision }
      });
      expect(put.statusCode, put.body).toBe(200);
      const updated = required(
        await instance.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: KB
        })
      );
      const revision = required(
        await instance.stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: KB,
          revision: updated.revision
        })
      );
      const { createActorAccess } = await import("@work-shape/catalyst-core");
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
      await instance.stores.transaction(async (stores) => {
        await knowledge.publish(stores, {
          access,
          assetId: record.id,
          revision: updated.revision,
          config,
          replaced: asset.publishedConfig
        });
        await stores.configAssets.publishConfigAssetRevision({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: KB,
          assetId: record.id,
          revision: updated.revision,
          revisionId: revision.id
        });
      });
    }
    return {
      publishSources,
      recordFailures,
      ...fixture,
      dataStores,
      openSource,
      knowledge,
      instance,
      sql,
      logs,
      platform,
      worker,
      jobs: worker,
      embed,
      sync,
      drain,
      objects,
      files,
      record
    };
  }

  return { setup };
}
