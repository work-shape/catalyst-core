import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type ActorAccess,
  type ConfigAssetRecord,
  type PublishNarrativeAudience,
  type PublishNarrativeStoreReaders,
  type PublishNarrativeStoredData
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";
import { assetResource, createAudienceReader, type AudienceReader } from "./store-audience";
import { appDataSources, appUse, knowledgeBaseUse } from "./used-by";
import { DATA_STORE_USED_BY_MAX_ASSETS } from "./workflow-data-flows";

// What the publish question's sentence says of stored data (PUBQ-1 on DS-13b): who may use an
// App revision and what it reads, and who reads the stores a Workflow revision writes. It is
// read from the published definitions and the grants, as the store's page reads it: no
// database of a store is asked, and only what the reader may be shown is named.

const APP_KIND = "app";
const APP_RIGHTS = { read: "app.read", use: "app.use" } as const;

/** The people and holders of an audience, counted. */
function counted(audience: Awaited<ReturnType<AudienceReader["of"]>>): PublishNarrativeAudience {
  return {
    ...(audience.app ? { app: audience.app } : {}),
    ...(audience.workspace ? { workspace: audience.workspace } : {}),
    holders: audience.holders.length + audience.hiddenHolders
  };
}

const storeTitleSchema = z.object({ title: z.string().min(1) });

/** Who reads the stores, by name: through published Apps and Knowledge Bases. */
async function storeReaders(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  names: readonly string[]
): Promise<PublishNarrativeStoreReaders[]> {
  const { clientInstanceId, stores } = runtime;
  const published = (kind: string, only?: readonly string[]) =>
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind,
      ...(only ? { names: only } : {}),
      // One more than the bound, to know that more exist; only the bound is looked through.
      limit: only ? only.length : DATA_STORE_USED_BY_MAX_ASSETS + 1
    });
  const [storeAssets, listedApps, listedBases] = await Promise.all([
    published(DATA_STORE_ASSET_KIND, names),
    published(APP_KIND),
    published(KNOWLEDGE_BASE_ASSET_KIND)
  ]);
  const assetsTruncated =
    Math.max(listedApps.length, listedBases.length) > DATA_STORE_USED_BY_MAX_ASSETS;
  const apps = listedApps.slice(0, DATA_STORE_USED_BY_MAX_ASSETS);
  const knowledgeBases = listedBases.slice(0, DATA_STORE_USED_BY_MAX_ASSETS);
  const shown = (asset: ConfigAssetRecord, rights: readonly string[]) =>
    rights.some((right) => access.authorize(right, assetResource(asset)).allowed);
  const audiences = createAudienceReader(runtime, access);
  await audiences.readWorkspaces(
    [...apps, ...knowledgeBases].flatMap((asset) =>
      asset.scope.kind === "workspace" ? [asset.scope.workspaceId] : []
    )
  );
  const active = (assets: readonly ConfigAssetRecord[]) =>
    assets.filter((asset) => asset.status === "active");
  const answered = await Promise.all(
    names.map(async (name) => {
      const storeAsset = storeAssets.find((asset) => asset.name === name);
      const title =
        storeAsset && shown(storeAsset, [DATA_STORE_ACTIONS.read, DATA_STORE_ACTIONS.write])
          ? storeTitleSchema.safeParse(storeAsset.publishedConfig).data?.title
          : undefined;
      let hidden = 0;
      const readers: PublishNarrativeStoreReaders["readers"][number][] = [];
      for (const app of active(apps)) {
        const use = appUse(app, name);
        if (!use?.reads) continue;
        if (!shown(app, [APP_RIGHTS.read, APP_RIGHTS.use])) {
          hidden += 1;
          continue;
        }
        readers.push({
          kind: "app",
          title: use.title,
          audience: counted(await audiences.of(APP_RIGHTS.use, assetResource(app)))
        });
      }
      for (const base of active(knowledgeBases)) {
        const baseTitle = knowledgeBaseUse(base, name);
        if (baseTitle === undefined) continue;
        if (!shown(base, [KNOWLEDGE_BASE_ACTIONS.read, KNOWLEDGE_BASE_ACTIONS.use])) {
          hidden += 1;
          continue;
        }
        readers.push({
          kind: "knowledge_base",
          title: baseTitle,
          audience: counted(await audiences.of(KNOWLEDGE_BASE_ACTIONS.use, assetResource(base)))
        });
      }
      return { store: name, title: title ?? name, readers, hidden };
    })
  );
  // Read after every audience: a grant read past its bound sets it.
  const truncated = assetsTruncated || audiences.truncated();
  return answered.map((store) => ({ ...store, truncated }));
}

/** The stored-data answers of the publish question's sentence. */
export function createPublishNarrativeData(runtime: DataStoreRuntime): PublishNarrativeStoredData {
  return {
    async appRevision(access, app, revision) {
      const sources = await appDataSources(runtime, access, app, revision);
      return {
        ...(sources.audience ? { audience: counted(sources.audience) } : {}),
        stores: sources.stores.map((store) => ({
          title: store.title,
          unavailable: store.unavailable === true,
          fillers: store.fillers.map((filler) => ({
            title: filler.title,
            connections: filler.connections
          }))
        })),
        truncated: sources.truncated
      };
    },
    storeReaders: (access, names) => storeReaders(runtime, access, names)
  };
}
