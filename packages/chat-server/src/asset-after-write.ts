import type { JsonObject } from "@work-shape/catalyst-core";
import type { AssetCall } from "./asset-access";
import { recordAssetEvent, type AssetTarget } from "./asset-target";
import type { AssetWorkflowOptions } from "./types";

// What a kind does beside a committed write or delete of a config revision. The write stands
// whatever happens here: a failure is logged and the call is answered as done.

type AfterOptions = Pick<AssetWorkflowOptions, "clientInstanceId" | "stores" | "logger">;

/** What the kind of a written asset does beside the write. */
export async function afterWrite(
  options: AfterOptions,
  call: AssetCall,
  target: AssetTarget,
  write: { previous: unknown; config: JsonObject }
): Promise<void> {
  const { kind, name } = target;
  if (!kind.afterWrite) return;
  try {
    await kind.afterWrite({
      clientInstanceId: options.clientInstanceId,
      name,
      ...write,
      stores: options.stores
    });
  } catch (error) {
    options.logger.error(
      { correlationId: call.correlationId, error: error instanceof Error ? error.message : "" },
      `A ${kind.kind} was written but what its kind does beside the write failed`
    );
  }
}

/** What the kind of a deleted asset does beside the delete, for a kind whose revisions are a config. */
export async function afterRemove(
  options: AfterOptions,
  call: AssetCall,
  target: AssetTarget
): Promise<void> {
  const { kind, asset } = target;
  if (!kind.onRemove || !asset) return;
  try {
    await kind.onRemove({
      clientInstanceId: options.clientInstanceId,
      assetId: asset.id,
      ...(asset.publishedConfig === undefined ? {} : { published: asset.publishedConfig }),
      stores: options.stores
    });
  } catch (error) {
    options.logger.error(
      { correlationId: call.correlationId, error: error instanceof Error ? error.message : "" },
      `A ${kind.kind} was deleted but what its kind does beside the delete failed`
    );
  }
}

/**
 * Clears the unused "Run live once" switches of an asset whose draft another revision is now,
 * for a kind whose drafts make calls: after a save, a sync or a revert, and before a discard.
 * Each is an audit row with the person who changed the draft as its actor, so an approval
 * given for one draft never carries over to an edited one (ADR-0031). A switch a test run is
 * using stays with that run. The change of the draft stands whatever happens here: a failure
 * is logged.
 */
export async function clearLiveOnceSwitches(
  options: AfterOptions,
  call: AssetCall,
  kind: { kind: string; draftCalls?: boolean },
  name: string,
  assetId: string | undefined
): Promise<void> {
  if (kind.draftCalls !== true || assetId === undefined) return;
  try {
    const cleared = await options.stores.liveOnceSwitches.clearStale({
      clientInstanceId: options.clientInstanceId,
      assetId
    });
    for (const stale of cleared) {
      await recordAssetEvent(call, "live_once.cleared", {
        kind: kind.kind,
        name,
        revisionId: stale.revisionId,
        part: stale.part,
        switchedBy: stale.switchedBy.id,
        reason: "draft_changed"
      });
    }
  } catch (error) {
    options.logger.error(
      { correlationId: call.correlationId, error: error instanceof Error ? error.message : "" },
      `The draft of ${kind.kind} '${name}' changed but its Run live once switches were not cleared`
    );
  }
}
