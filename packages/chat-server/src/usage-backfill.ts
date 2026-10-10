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
  /**
   * The backfill changed events and the daily sums have not been compared with the events
   * since. Written with the first batch that changes something, and taken away only by the
   * transaction of that comparison: a process that is killed in between leaves it standing.
   */
  repairNeeded?: true;
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
    ...(typeof stored?.verifiedAt === "string" ? { verifiedAt: stored.verifiedAt } : {}),
    ...(stored?.repairNeeded === true ? { repairNeeded: true } : {})
  };
}

function storedState(state: UsageBackfillState): JsonObject {
  return {
    changedInPass: state.changedInPass,
    ...(state.after ? { after: { ...state.after } } : {}),
    ...(state.verifiedAt ? { verifiedAt: state.verifiedAt } : {}),
    ...(state.repairNeeded ? { repairNeeded: true } : {})
  };
}

/**
 * The attribution backfill as its schedule runs it. A pass goes through the usage events of
 * the instance once, a batch per transaction, and each batch writes where it ended with it: a
 * process that is killed loses one batch, and the next tick of any process goes on from there.
 * A pass that changed something is followed by another on the next tick, and by a comparison
 * of the daily sums with the events, because an event that gains a purpose or a region moves
 * to another sum. That comparison is owed from the first batch that changes something until
 * its own transaction commits, and the state says so: a tick that finds it owed makes it,
 * whatever became of the process that owed it. A pass that changed nothing is recorded, and
 * the ticks do nothing until `USAGE_BACKFILL_VERIFY_EVERY_MS` has passed: then the events are
 * read again, because a process of the previous release may have written since. That goes on
 * until the contract step removes the job.
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

  /**
   * Goes through the events once, from where `from` stands. Resolves with the state after the
   * last event, or with nothing when it was stopped before.
   */
  async function pass(
    control: JobControl,
    from: UsageBackfillState
  ): Promise<UsageBackfillState | undefined> {
    let state = from;
    while (!control.signal.aborted) {
      const ended = await control.transaction(async (stores) => {
        const batch = await stores.usage.backfillModelUsageAttribution({
          clientInstanceId,
          targets,
          ...(state.after === undefined ? {} : { after: state.after }),
          limit: USAGE_BACKFILL_BATCH
        });
        const changedInPass = state.changedInPass + batch.changedCount;
        const repair: Pick<UsageBackfillState, "repairNeeded"> =
          state.repairNeeded || batch.changedCount > 0 ? { repairNeeded: true } : {};
        const next: UsageBackfillState = batch.next
          ? { after: batch.next, changedInPass, ...repair }
          : {
              changedInPass: 0,
              ...(changedInPass === 0 ? { verifiedAt: now().toISOString() } : {}),
              ...repair
            };
        await stores.usage.writeModelUsageMaintenance({
          clientInstanceId,
          task: USAGE_BACKFILL_TASK,
          state: storedState(next)
        });
        state = next;
        return batch.next ? undefined : { changedCount: changedInPass };
      });
      if (!ended) continue;
      control.logger.info(ended, "Usage attribution backfill pass ended");
      return state;
    }
    return undefined;
  }

  return {
    async run(control) {
      const found = readState(
        await options.stores.usage.readModelUsageMaintenance({
          clientInstanceId,
          task: USAGE_BACKFILL_TASK
        })
      );
      const verified =
        found.verifiedAt !== undefined &&
        now().getTime() - new Date(found.verifiedAt).getTime() < USAGE_BACKFILL_VERIFY_EVERY_MS;
      const state = verified ? found : await pass(control, found);
      if (!state?.repairNeeded) return;
      const { repairNeeded: _repaired, ...repaired } = state;
      await control.transaction(async (stores) => {
        await stores.usage.reconcileModelUsage({ clientInstanceId, scope: "all" });
        await stores.usage.writeModelUsageMaintenance({
          clientInstanceId,
          task: USAGE_BACKFILL_TASK,
          state: storedState(repaired)
        });
      });
    }
  };
}

/** What the reconciliation recorded of its last run. */
interface UsageReconciliationState {
  /** Whether the daily sums were built from the events that were there before the sums. */
  sumsBuilt: boolean;
  /** When the last run began. The next one reads the events from the month of that moment. */
  reconciledAt: string;
}

/**
 * The comparison of the counters and the daily sums with the usage events, as its schedule
 * runs it. The first run after the upgrade reads every event and builds the sums of the days
 * before the upgrade; it is recorded with its moment, and the runs after it read the events
 * from the month of the run before, at least those of the current month. A record without a
 * moment counts as none. They find what a process of the
 * previous release wrote, which adds to no counter and no sum: also after a rollback of any
 * length, during which no run was made and that release wrote every event.
 */
export function createUsageReconciliation(
  options: ChatServerOptions,
  now: () => Date = () => new Date()
): {
  run(control: JobControl): Promise<void>;
} {
  const { clientInstanceId } = options;
  return {
    async run(control) {
      const stored = await options.stores.usage.readModelUsageMaintenance({
        clientInstanceId,
        task: USAGE_RECONCILIATION_TASK
      });
      const since = typeof stored?.reconciledAt === "string" ? stored.reconciledAt : undefined;
      // A state without the moment of its run says nothing of the months since: a release
      // before this one wrote it, and a rollback may lie between. Every event is read then.
      const built = stored?.sumsBuilt === true && since !== undefined;
      const state: UsageReconciliationState = {
        sumsBuilt: true,
        reconciledAt: now().toISOString()
      };
      const corrected = await control.transaction(async (stores) => {
        const result = await stores.usage.reconcileModelUsage({
          clientInstanceId,
          scope: built ? "recent" : "all",
          ...(since === undefined ? {} : { since })
        });
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
