import {
  appAudienceWidens,
  type AppAudience,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { WorkflowAssetKind } from "../asset-kinds/shared";

/**
 * The reach checked before admission and frozen for the committing transaction to recheck.
 * The content widens with a changing action that is new or changed (an action that does not
 * say it only reads counts as changing), an outside host, or a Connection or a Data Store the
 * live revision does not use; the publish widens on a first publish, with its content, or with
 * a wider audience. The default publish guardrail asks only where it widens (GR-PUB-2).
 */
export function appPublishReview(
  asset: Pick<ConfigAssetRecord, "publishedRevisionId" | "publishedConfig" | "appAvailability">,
  kind: Pick<WorkflowAssetKind, "publishReach">,
  config: JsonObject,
  chosen?: AppAudience,
  personId?: string
) {
  const reach = kind.publishReach?.(config, asset.publishedConfig);
  const before = asset.publishedConfig
    ? kind.publishReach?.(asset.publishedConfig, asset.publishedConfig)
    : undefined;
  const contentWidens =
    !reach ||
    reach.calls.some((item) => item.effect !== "reading") ||
    reach.hostsAdded.length > 0 ||
    reach.connections.some((item) => !before?.connections.includes(item)) ||
    reach.dataStores.some((store) => !before?.dataStores.some((live) => live.name === store.name));
  const liveAudience = asset.appAvailability ?? { audience: "workspace" as const };
  return {
    liveRevisionId: asset.publishedRevisionId ?? null,
    liveAudience,
    contentWidens,
    publishWidens:
      !asset.publishedRevisionId ||
      contentWidens ||
      appAudienceWidens(
        chosen ?? liveAudience.audience,
        liveAudience.audience,
        chosen === "self" ? personId : liveAudience.userId,
        liveAudience.userId
      )
  };
}

export type AppPublishReview = ReturnType<typeof appPublishReview>;
