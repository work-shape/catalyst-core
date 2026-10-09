import type { StorePage } from "@vivd-catalyst/core";
import {
  type AuditEvent,
  type AuditEventInput,
  type AuditEventStore,
  type ClientInstanceId
} from "@vivd-catalyst/core";
import {
  appendAuditEvent as appendPostgresAuditEvent,
  listAuditEvents as listPostgresAuditEvents
} from "../postgres-audit-usage-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresAuditStore(db: PostgresConnection): AuditEventStore {
  return {
    async appendAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
      return appendPostgresAuditEvent(db, input);
    },
    async listAuditEvents(input: {
      clientInstanceId: ClientInstanceId;
      limit?: number;
      type?: string;
      page?: StorePage;
    }): Promise<AuditEvent[]> {
      return listPostgresAuditEvents(db, input);
    }
  };
}
