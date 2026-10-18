import {
  appAudienceWidens,
  type AppAudience,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { WorkflowAssetKind } from "../asset-kinds/shared";

/** The reach checked before admission and frozen for the committing transaction to recheck. */
export function appPublishReview(
  asset: ConfigAssetRecord,
  kind: WorkflowAssetKind,
  config: JsonObject,
  chosen?: AppAudience,
  personId?: string
) {
  const reach = kind.publishReach?.(config, asset.publishedConfig);
  const before = asset.publishedConfig
    ? kind.publishReach?.(asset.publishedConfig, asset.publishedConfig)
    : undefined;
  const contentWidens = Boolean(
    reach &&
    (reach.calls.some((item) => item.effect === "changing") ||
      reach.hostsAdded.length > 0 ||
      reach.connections.some((item) => !before?.connections.includes(item)))
  );
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
