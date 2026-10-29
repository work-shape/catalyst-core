import type { AssetWorkflowOptions } from "../types";
import {
  recordHandover,
  transactionalAssetCall,
  withoutHandover,
  type AssetCall
} from "./asset-access";

/**
 * Makes a change that does not open a transaction of its own in one where it confirmed a
 * hand-over, with the hand-over's rows: either both commit or neither. Without one it is made
 * as it is.
 */
export async function committingHandover<T>(
  options: AssetWorkflowOptions,
  call: AssetCall,
  change: (within: AssetWorkflowOptions, called: AssetCall) => Promise<T>
): Promise<T> {
  if (!call.handover?.length) return change(options, call);
  return options.stores.transaction(async (stores) => {
    const within: AssetWorkflowOptions = {
      ...options,
      stores,
      configAssets: { ...options.configAssets, store: stores.configAssets }
    };
    const called = transactionalAssetCall(call, options.clientInstanceId, stores.audit);
    const result = await change(within, withoutHandover(called));
    await recordHandover(called);
    return result;
  });
}
