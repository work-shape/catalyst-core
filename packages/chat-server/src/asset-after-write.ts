import type { JsonObject } from "@vivd-catalyst/core";
import type { AssetCall } from "./asset-access";
import type { AssetTarget } from "./asset-target";
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
