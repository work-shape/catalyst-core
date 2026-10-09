import type { StorePage } from "@vivd-catalyst/core";
import {
  type ClientInstanceId,
  type ModelUsageEvent,
  type ModelUsageEventRecordInput,
  type ModelUsageEventStore,
  type ModelUsageWindowSummary
} from "@vivd-catalyst/core";
import {
  appendModelUsageEvent as appendPostgresModelUsageEvent,
  listModelUsageEvents as listPostgresModelUsageEvents,
  summarizeModelUsageEvents as summarizePostgresModelUsageEvents
} from "../postgres-audit-usage-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresUsageStore(db: PostgresConnection): ModelUsageEventStore {
  return {
    async appendModelUsageEvent(input: ModelUsageEventRecordInput): Promise<ModelUsageEvent> {
      return appendPostgresModelUsageEvent(db, input);
    },
    async summarizeModelUsageEvents(input: {
      clientInstanceId: ClientInstanceId;
      start?: string;
      end?: string;
    }): Promise<ModelUsageWindowSummary> {
      return summarizePostgresModelUsageEvents(db, input);
    },
    async listModelUsageEvents(input: {
      clientInstanceId: ClientInstanceId;
      start?: string;
      end?: string;
      limit?: number;
      page?: StorePage;
    }): Promise<ModelUsageEvent[]> {
      return listPostgresModelUsageEvents(db, input);
    }
  };
}
