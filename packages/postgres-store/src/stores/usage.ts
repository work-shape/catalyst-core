import type { ModelUsageEventStore } from "@vivd-catalyst/core";
import {
  appendModelUsageEvent,
  backfillModelUsageAttribution,
  clearUserFromModelUsageEvents,
  clearWorkspaceFromModelUsageEvents,
  listModelUsageEvents,
  reserveModelUsageEvent,
  settleModelUsageEvent,
  summarizeModelUsageHistory,
  summarizeRecentModelUsage
} from "../postgres-audit-usage-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresUsageStore(db: PostgresConnection): ModelUsageEventStore {
  return {
    appendModelUsageEvent: (input) => appendModelUsageEvent(db, input),
    reserveModelUsageEvent: (input) => reserveModelUsageEvent(db, input),
    settleModelUsageEvent: (input) => settleModelUsageEvent(db, input),
    summarizeModelUsageHistory: (input) => summarizeModelUsageHistory(db, input),
    summarizeRecentModelUsage: (input) => summarizeRecentModelUsage(db, input),
    listModelUsageEvents: (input) => listModelUsageEvents(db, input),
    clearUserFromModelUsageEvents: (input) => clearUserFromModelUsageEvents(db, input),
    clearWorkspaceFromModelUsageEvents: (input) => clearWorkspaceFromModelUsageEvents(db, input),
    backfillModelUsageAttribution: (input) => backfillModelUsageAttribution(db, input)
  };
}
