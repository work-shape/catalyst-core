import { keysetFilter } from "./paging";
import type { StorePage } from "@vivd-catalyst/core";
import { and, desc, eq, gte, lt, sql as drizzleSql } from "drizzle-orm";
import {
  type AuditEvent,
  type AuditEventInput,
  type ClientInstanceId,
  type ModelUsageEvent,
  type ModelUsageEventRecordInput,
  type ModelUsageWindowSummary,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { mapAuditEvent, mapModelUsageEvent } from "./rows";
import { auditEvents, modelUsageEvents } from "./schema";

export async function appendAuditEvent(
  db: PostgresConnection,
  input: AuditEventInput
): Promise<AuditEvent> {
  const id = createPlatformId<"AuditEventId">("audit");
  const [row] = await db
    .insert(auditEvents)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      type: input.type,
      status: input.status,
      actor: input.actor ?? null,
      subject: input.subject ?? null,
      reason: input.reason ?? null,
      correlationId: input.correlationId,
      createdAt: new Date(),
      metadata: input.metadata ?? {}
    })
    .returning();
  return mapAuditEvent(row);
}

export async function listAuditEvents(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    limit?: number;
    type?: string;
    page?: StorePage;
  }
): Promise<AuditEvent[]> {
  const limit = input.limit ?? 100;
  const filters = input.type
    ? and(
        eq(auditEvents.clientInstanceId, input.clientInstanceId),
        eq(auditEvents.type, input.type)
      )
    : eq(auditEvents.clientInstanceId, input.clientInstanceId);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(filters, keysetFilter(input.page, [auditEvents.createdAt, auditEvents.id], true)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(input.page?.limit ?? limit);
  return rows.map(mapAuditEvent);
}

export async function deleteAuditEventsBefore(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; createdBefore: string }
): Promise<number> {
  const removed = await db
    .delete(auditEvents)
    .where(
      and(
        eq(auditEvents.clientInstanceId, input.clientInstanceId),
        lt(auditEvents.createdAt, new Date(input.createdBefore))
      )
    );
  return removed.count;
}

export async function appendModelUsageEvent(
  db: PostgresConnection,
  input: ModelUsageEventRecordInput
): Promise<ModelUsageEvent> {
  const id = createPlatformId<"ModelUsageEventId">("usage");
  const [row] = await db
    .insert(modelUsageEvents)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      agentRunId: input.agentRunId,
      agentName: input.agentName,
      providerId: input.providerId,
      model: input.model,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens ?? null,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      webSearchCallCount: input.webSearchCallCount ?? 0,
      fastMode: input.fastMode,
      providerServiceTier: input.providerServiceTier ?? null,
      source: input.source,
      customerBillableCost: input.customerBillableCost,
      correlationId: input.correlationId,
      createdAt: new Date()
    })
    .returning();
  return mapModelUsageEvent(row);
}

export async function summarizeModelUsageEvents(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
  }
): Promise<ModelUsageWindowSummary> {
  const [row] = await db
    .select({
      modelCallCount: drizzleSql<number>`count(*)::int`,
      inputTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.inputTokens}), 0)::int`,
      cachedInputTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.cachedInputTokens}), 0)::int`,
      outputTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.outputTokens}), 0)::int`,
      totalTokens: drizzleSql<number>`coalesce(sum(${modelUsageEvents.totalTokens}), 0)::int`,
      webSearchCallCount: drizzleSql<number>`coalesce(sum(${modelUsageEvents.webSearchCallCount}), 0)::int`
    })
    .from(modelUsageEvents)
    .where(and(...modelUsageFilters(input)));

  return {
    start: input.start,
    end: input.end,
    modelCallCount: row?.modelCallCount ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    cachedInputTokens: row?.cachedInputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    webSearchCallCount: row?.webSearchCallCount ?? 0
  };
}

export async function listModelUsageEvents(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
    limit?: number;
    page?: StorePage;
  }
): Promise<ModelUsageEvent[]> {
  const query = db
    .select()
    .from(modelUsageEvents)
    .where(
      and(
        ...modelUsageFilters(input),
        keysetFilter(input.page, [modelUsageEvents.createdAt, modelUsageEvents.id], true)
      )
    )
    .orderBy(desc(modelUsageEvents.createdAt), desc(modelUsageEvents.id));
  const rows = await query.limit(input.page?.limit ?? input.limit ?? 2147483647);
  return rows.map(mapModelUsageEvent);
}

function modelUsageFilters(input: {
  clientInstanceId: ClientInstanceId;
  start?: string;
  end?: string;
}) {
  return [
    eq(modelUsageEvents.clientInstanceId, input.clientInstanceId),
    ...(input.start ? [gte(modelUsageEvents.createdAt, new Date(input.start))] : []),
    ...(input.end ? [lt(modelUsageEvents.createdAt, new Date(input.end))] : [])
  ];
}
