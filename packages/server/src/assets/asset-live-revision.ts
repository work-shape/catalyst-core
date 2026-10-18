import {
  AppError,
  type ConfigAssetRevisionRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { assertReferencesWithinOwners } from "./asset-owner-references";
import type { AssetCall } from "./asset-access";
import type { AssetTarget } from "./asset-target";
import type { AssetWorkflowOptions } from "../types";

/**
 * The revision a publish makes live, after the kind's own check of who may make it live
 * (`authorizeLive`). Asked when a publish is called and again when it is executed, so a
 * publish that waits for an approval is checked against its caller when it is filed and when
 * the approval applies it.
 */
export async function liveRevision(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets" | "stores" | "config">,
  call: Pick<AssetCall, "actor" | "access" | "runtime">,
  target: AssetTarget,
  number: number
): Promise<ConfigAssetRevisionRecord & { config: JsonObject }> {
  const { kind, name } = target;
  const revision = await options.configAssets.store.getConfigAssetRevision({
    clientInstanceId: options.clientInstanceId,
    kind: kind.kind,
    name,
    revision: number
  });
  if (!revision || revision.config === null) {
    throw new AppError(
      "NOT_FOUND",
      `Config ${kind.kind} '${name}' has no revision ${number} to publish`,
      { reason: "revision_unknown", revision: number }
    );
  }
  const assets = await options.configAssets.store.listActiveConfigAssets({
    clientInstanceId: options.clientInstanceId
  });
  await assertReferencesWithinOwners(
    options.configAssets.kinds.kinds,
    [
      {
        type: "upsert",
        kind: kind.kind,
        name,
        scope: target.scope,
        config: revision.config
      }
    ],
    assets,
    call.runtime?.locale ?? options.config.localization.defaultLocale,
    options
  );
  await kind.authorizeLive?.({
    actor: call.actor,
    access: call.access,
    name,
    revision: number,
    config: revision.config
  });
  return { ...revision, config: revision.config };
}
