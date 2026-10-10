import type { ModelUsageEventStore } from "@vivd-catalyst/core";
import {
  backfillModelUsageAttribution,
  clearUserFromModelUsageEvents,
  clearWorkspaceFromModelUsageEvents,
  listModelUsageEvents
} from "../postgres-audit-usage-operations";
import type { PostgresConnection } from "../postgres-database";
import {
  admitModelUsageEvent,
  appendModelUsageEvent,
  listPendingModelUsageEvents,
  reconcileModelUsage,
  settleModelUsageEvent,
  summarizeModelUsageHistory,
  summarizeRecentModelUsage
} from "../postgres-usage-ledger";
import {
  readModelUsageMaintenance,
  writeModelUsageMaintenance
} from "../postgres-usage-maintenance";

export function createPostgresUsageStore(db: PostgresConnection): ModelUsageEventStore {
  return {
    appendModelUsageEvent: (input, counted) => appendModelUsageEvent(db, input, counted),
    admitModelUsageEvent: (input) => admitModelUsageEvent(db, input),
    settleModelUsageEvent: (input) => settleModelUsageEvent(db, input),
    listPendingModelUsageEvents: (input) => listPendingModelUsageEvents(db, input),
    summarizeModelUsageHistory: (input) => summarizeModelUsageHistory(db, input),
    summarizeRecentModelUsage: (input) => summarizeRecentModelUsage(db, input),
    reconcileModelUsage: (input) => reconcileModelUsage(db, input),
    readModelUsageMaintenance: (input) => readModelUsageMaintenance(db, input),
    writeModelUsageMaintenance: (input) => writeModelUsageMaintenance(db, input),
    listModelUsageEvents: (input) => listModelUsageEvents(db, input),
    clearUserFromModelUsageEvents: (input) => clearUserFromModelUsageEvents(db, input),
    clearWorkspaceFromModelUsageEvents: (input) => clearWorkspaceFromModelUsageEvents(db, input),
    backfillModelUsageAttribution: (input) => backfillModelUsageAttribution(db, input)
  };
}
