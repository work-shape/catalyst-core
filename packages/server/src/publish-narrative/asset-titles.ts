import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  type AccessResource,
  type ActorAccess,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { oneLine } from "./narrative-copy";

/** What the titles are read from: the assets of the instance. */
export interface AssetTitleSource {
  clientInstanceId: ClientInstanceId;
  stores: {
    configAssets: {
      getConfigAsset(
        ...input: Parameters<ConfigAssetStore["getConfigAsset"]>
      ): Promise<
        | Pick<
            ConfigAssetRecord,
            "id" | "kind" | "name" | "scope" | "status" | "config" | "publishedConfig"
          >
        | undefined
      >;
    };
  };
}

const displayNameSchema = z.object({ displayName: z.string().min(1) });

/**
 * The names people read of the assets of one kind, by name, each read once: the title of each
 * one the reader may be shown by one of `rights`; its name, which the revision itself names,
 * for any other.
 */
export function assetTitles(
  source: AssetTitleSource,
  access: ActorAccess,
  kind: string,
  rights: readonly string[],
  title: (config: unknown) => string | undefined
) {
  const read = new Map<string, Promise<string>>();
  return (name: string): Promise<string> => {
    let found = read.get(name);
    if (!found) {
      found = source.stores.configAssets
        .getConfigAsset({ clientInstanceId: source.clientInstanceId, kind, name })
        .then((asset) => {
          if (asset?.status !== "active") return name;
          const resource: AccessResource = {
            kind: asset.kind,
            name: asset.name,
            assetId: asset.id,
            ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
          };
          const shown = rights.some((right) => access.authorize(right, resource).allowed);
          return oneLine(
            (shown ? title(asset.publishedConfig ?? asset.config) : undefined) ?? name
          );
        });
      read.set(name, found);
    }
    return found;
  };
}

/** A Connection's display name, for a reader who may read or use it; its name for any other. */
export function connectionTitles(source: AssetTitleSource, access: ActorAccess) {
  return assetTitles(
    source,
    access,
    CONNECTION_ASSET_KIND,
    [CONNECTION_ACTIONS.read, CONNECTION_ACTIONS.use],
    (config) => displayNameSchema.safeParse(config).data?.displayName
  );
}
