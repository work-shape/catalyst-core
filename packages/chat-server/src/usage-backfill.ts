import { getModelProviderConfigs } from "@vivd-catalyst/config-schema";
import type {
  JobControl,
  ModelBindingConfig,
  ModelProviderConfig,
  ModelUsageBackfillPosition,
  ModelUsageBackfillTarget
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/** Usage events one statement of the backfill reads, in the order they were written in. */
const USAGE_BACKFILL_BATCH = 5_000;

/**
 * The providers and models of the instance today, each with its region and, where exactly one
 * model binding names the pair, that binding. An event whose provider and model are no longer
 * configured matches none and keeps no region: nothing says where it was processed.
 */
function usageBackfillTargets(
  providers: readonly ModelProviderConfig[],
  bindings: readonly ModelBindingConfig[]
): ModelUsageBackfillTarget[] {
  return providers.flatMap((provider) => {
    const bindingIdsByModel = new Map<string, string[]>([[provider.model, []]]);
    for (const binding of bindings) {
      if (binding.providerId !== provider.id) continue;
      const model = binding.model ?? provider.model;
      bindingIdsByModel.set(model, [...(bindingIdsByModel.get(model) ?? []), binding.id]);
    }
    return [...bindingIdsByModel].map(([model, bindingIds]) => {
      const [bindingId] = bindingIds;
      return {
        providerId: provider.id,
        model,
        ...(provider.region ? { region: provider.region } : {}),
        ...(bindingIds.length === 1 && bindingId !== undefined ? { bindingId } : {})
      };
    });
  });
}

/**
 * The attribution backfill as its schedule runs it. A tick goes through the usage events of the
 * instance once, a batch per statement, and stops between two batches when the worker stops.
 * A pass that changed something is followed by another on the next tick, which also reaches
 * what a process of the previous release wrote meanwhile. After a pass that changed nothing
 * the ticks of this process do nothing. The place in a pass is this process's: a new process
 * starts over, and what is filled already is read and left alone.
 */
export function createUsageAttributionBackfill(options: ChatServerOptions): {
  run(control: JobControl): Promise<void>;
} {
  const targets = usageBackfillTargets(
    getModelProviderConfigs(options.config),
    options.config.modelBindings
  );
  let after: ModelUsageBackfillPosition | undefined;
  let changedInPass = 0;
  let complete = false;
  return {
    async run(control) {
      while (!complete && !control.signal.aborted) {
        const batch = await control.transaction((stores) =>
          stores.usage.backfillModelUsageAttribution({
            clientInstanceId: options.clientInstanceId,
            targets,
            ...(after === undefined ? {} : { after }),
            limit: USAGE_BACKFILL_BATCH
          })
        );
        changedInPass += batch.changedCount;
        after = batch.next;
        if (after !== undefined) continue;
        control.logger.info(
          { changedCount: changedInPass },
          "Usage attribution backfill pass ended"
        );
        complete = changedInPass === 0;
        changedInPass = 0;
        return;
      }
    }
  };
}
