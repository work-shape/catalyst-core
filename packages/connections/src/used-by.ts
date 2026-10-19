import {
  PUBLISHED_DATA_CONSUMER_KINDS,
  type PublishedDataConsumerKind,
  parseConnectionOperationName,
  workflowStepsDeep,
  type AccessResource,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { ConnectionOperationSourceDeps } from "./connection-reads";

// As in data-stores/used-by, derive consumers from their published definitions. Drafts and
// reverse links cannot describe what is live. Rights are checked before a title leaves here.

/** Bounds each published-kind scan; the page tells the reader when more assets exist. */
const CONNECTION_USED_BY_MAX_ASSETS = 1_000;

export interface ConnectionConsumer {
  kind: PublishedDataConsumerKind;
  name: string;
  workspaceId?: string;
  title: string;
}

const appSchema = z.object({
  title: z.string().optional(),
  manifest: z.object({
    connections: z.array(z.string()).optional(),
    actions: z.array(z.unknown()).optional()
  })
});
const connectionActionSchema = z.object({ kind: z.literal("connection"), connection: z.string() });
const workflowSchema = z.object({
  manifest: z.object({
    name: z.string().optional(),
    steps: z.unknown(),
    tools: z.array(z.string()).optional()
  })
});
const knowledgeSchema = z.object({
  title: z.string().optional(),
  sources: z.array(z.object({ connection: z.string() })).optional()
});

function consumerTitle(asset: ConfigAssetRecord, connection: string): string | undefined {
  switch (asset.kind) {
    case "app": {
      const parsed = appSchema.safeParse(asset.publishedConfig);
      if (!parsed.success) return undefined;
      const { title, manifest } = parsed.data;
      const calls =
        manifest.connections?.includes(connection) ||
        manifest.actions?.some((action) => {
          const parsed = connectionActionSchema.safeParse(action);
          return parsed.success && parsed.data.connection === connection;
        });
      return calls ? (title ?? asset.name) : undefined;
    }
    case "workflow": {
      const parsed = workflowSchema.safeParse(asset.publishedConfig);
      if (!parsed.success) return undefined;
      const { manifest } = parsed.data;
      const calls = [
        ...workflowStepsDeep(manifest.steps).flatMap((step) =>
          step.type === "operation" && typeof step.operation === "string" ? [step.operation] : []
        ),
        ...(manifest.tools ?? [])
      ];
      return calls.some((call) => parseConnectionOperationName(call)?.connection === connection)
        ? (manifest.name ?? asset.name)
        : undefined;
    }
    case "knowledge_base": {
      const parsed = knowledgeSchema.safeParse(asset.publishedConfig);
      return parsed.success &&
        parsed.data.sources?.some((source) => source.connection === connection)
        ? (parsed.data.title ?? asset.name)
        : undefined;
    }
    default:
      return undefined;
  }
}

export async function connectionConsumers(
  { clientInstanceId, stores }: Pick<ConnectionOperationSourceDeps, "clientInstanceId" | "stores">,
  name: string,
  readable: (resource: AccessResource) => boolean
): Promise<{ assets: ConnectionConsumer[]; truncated: boolean }> {
  const kinds = PUBLISHED_DATA_CONSUMER_KINDS;
  const pages = await Promise.all(
    kinds.map((kind) =>
      stores.configAssets.listPublishedConfigAssets({
        clientInstanceId,
        kind,
        limit: CONNECTION_USED_BY_MAX_ASSETS + 1
      })
    )
  );
  const assets: ConnectionConsumer[] = [];
  for (const [index, kind] of kinds.entries()) {
    for (const asset of (pages[index] ?? []).slice(0, CONNECTION_USED_BY_MAX_ASSETS)) {
      if (
        asset.status !== "active" ||
        !readable({
          kind,
          name: asset.name,
          assetId: asset.id,
          ...(asset.appAvailability === undefined
            ? {}
            : { appAvailability: asset.appAvailability }),
          ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
        })
      )
        continue;
      const title = consumerTitle(asset, name);
      if (title !== undefined)
        assets.push({
          kind,
          name: asset.name,
          title,
          ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
        });
    }
  }
  return { assets, truncated: pages.some((page) => page.length > CONNECTION_USED_BY_MAX_ASSETS) };
}
