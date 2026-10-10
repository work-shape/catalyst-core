import { getModelProviderConfigs } from "@vivd-catalyst/config-schema";
import type {
  JobControl,
  JsonObject,
  ModelBindingConfig,
  ModelProviderConfig,
  ModelUsageBackfillPosition,
  ModelUsageBackfillTarget
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/** Usage events one statement of the backfill reads, in the order they were written in. */
const USAGE_BACKFILL_BATCH = 5_000;
/**
 * How long after a pass without a change the events are read again. A process of the previous
 * release may write events without attribution for as long as one runs.
 */
const USAGE_BACKFILL_VERIFY_EVERY_MS = 24 * 60 * 60 * 1000;
const USAGE_BACKFILL_TASK = "attribution_backfill";
const USAGE_RECONCILIATION_TASK = "reconciliation";

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

/** Where the backfill stands, in the database: a new process goes on from it. */
interface UsageBackfillState {
  /** The last event of the pass that is under way. Absent between two passes. */
  after?: ModelUsageBackfillPosition;
  /** What the pass that is under way has changed so far. */
  changedInPass: number;
  /** When a pass last ended without a change. Absent while a pass changed something. */
  verifiedAt?: string;
}

function readState(stored: JsonObject | undefined): UsageBackfillState {
  const after = stored?.after;
  const position =
    after !== null &&
    typeof after === "object" &&
    !Array.isArray(after) &&
    typeof after.createdAt === "string" &&
    typeof after.id === "string"
      ? { createdAt: after.createdAt, id: after.id }
      : undefined;
  return {
    ...(position ? { after: position } : {}),
    changedInPass: typeof stored?.changedInPass === "number" ? stored.changedInPass : 0,
    ...(typeof stored?.verifiedAt === "string" ? { verifiedAt: stored.verifiedAt } : {})
  };
}

/**
 * The attribution backfill as its schedule runs it. A pass goes through the usage events of
 * the instance once, a batch per transaction, and each batch writes where it ended with it: a
 * process that is killed loses one batch, and the next tick of any process goes on from there.
 * A pass that changed something is followed by another on the next tick, and by a comparison
 * of the daily sums with the events, because an event that gains a purpose or a region moves
 * to another sum. A pass that changed nothing is recorded, and the ticks do nothing until
 * `USAGE_BACKFILL_VERIFY_EVERY_MS` has passed: then the events are read again, because a
 * process of the previous release may have written since. That goes on until the contract step
 * removes the job.
 */
export function createUsageAttributionBackfill(
  options: ChatServerOptions,
  now: () => Date = () => new Date()
): {
  run(control: JobControl): Promise<void>;
} {
  const targets = usageBackfillTargets(
    getModelProviderConfigs(options.config),
    options.config.modelBindings
  );
  const { clientInstanceId } = options;
  return {
    async run(control) {
      let state = readState(
        await options.stores.usage.readModelUsageMaintenance({
          clientInstanceId,
          task: USAGE_BACKFILL_TASK
        })
      );
      if (
        state.verifiedAt !== undefined &&
        now().getTime() - new Date(state.verifiedAt).getTime() < USAGE_BACKFILL_VERIFY_EVERY_MS
      )
        return;
      state = {
        ...(state.after ? { after: state.after } : {}),
        changedInPass: state.changedInPass
      };
      while (!control.signal.aborted) {
        const ended = await control.transaction(async (stores) => {
          const batch = await stores.usage.backfillModelUsageAttribution({
            clientInstanceId,
            targets,
            ...(state.after === undefined ? {} : { after: state.after }),
            limit: USAGE_BACKFILL_BATCH
          });
          const changedInPass = state.changedInPass + batch.changedCount;
          state = batch.next
            ? { after: batch.next, changedInPass }
            : {
                changedInPass: 0,
                ...(changedInPass === 0 ? { verifiedAt: now().toISOString() } : {})
              };
          await stores.usage.writeModelUsageMaintenance({
            clientInstanceId,
            task: USAGE_BACKFILL_TASK,
            state: {
              changedInPass: state.changedInPass,
              ...(state.after ? { after: { ...state.after } } : {}),
              ...(state.verifiedAt ? { verifiedAt: state.verifiedAt } : {})
            }
          });
          return batch.next ? undefined : { changedCount: changedInPass };
        });
        if (!ended) continue;
        control.logger.info(ended, "Usage attribution backfill pass ended");
        if (ended.changedCount > 0) {
          await control.transaction((stores) =>
            stores.usage.reconcileModelUsage({ clientInstanceId, scope: "all" })
          );
        }
        return;
      }
    }
  };
}

/** Whether the daily sums were built from the events that were there before the sums. */
interface UsageReconciliationState {
  sumsBuilt: boolean;
}

/**
 * The comparison of the counters and the daily sums with the usage events, as its schedule
 * runs it. The first run after the upgrade reads every event and builds the sums of the days
 * before the upgrade; it is recorded, and the runs after it read the events of the month.
 * They find what a process of the previous release wrote, which adds to no counter and no sum.
 */
export function createUsageReconciliation(options: ChatServerOptions): {
  run(control: JobControl): Promise<void>;
} {
  const { clientInstanceId } = options;
  return {
    async run(control) {
      const stored = await options.stores.usage.readModelUsageMaintenance({
        clientInstanceId,
        task: USAGE_RECONCILIATION_TASK
      });
      const built = stored?.sumsBuilt === true;
      const corrected = await control.transaction(async (stores) => {
        const result = await stores.usage.reconcileModelUsage({
          clientInstanceId,
          scope: built ? "recent" : "all"
        });
        const state: UsageReconciliationState = { sumsBuilt: true };
        await stores.usage.writeModelUsageMaintenance({
          clientInstanceId,
          task: USAGE_RECONCILIATION_TASK,
          state: { ...state }
        });
        return result;
      });
      if (!built || corrected.correctedCounters + corrected.correctedSums > 0) {
        control.logger.info(
          { ...corrected, scope: built ? "recent" : "all" },
          "Usage counters and sums were corrected from the usage events"
        );
      }
    }
  };
}
