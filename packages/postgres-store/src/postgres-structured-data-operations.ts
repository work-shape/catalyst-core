import { and, desc, eq, sql } from "drizzle-orm";
import {
  createPlatformId,
  type StructuredDataResourceRecord,
  type StructuredDataStore
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
import { mapStructuredDataResource } from "./rows";
import { structuredDataResources } from "./schema";

export async function getStructuredDataResource(
  db: PostgresDatabase,
  input: Parameters<StructuredDataStore["getStructuredDataResource"]>[0]
): Promise<StructuredDataResourceRecord | undefined> {
  const [row] = await db
    .select()
    .from(structuredDataResources)
    .where(
      and(
        eq(structuredDataResources.clientInstanceId, input.clientInstanceId),
        eq(structuredDataResources.conversationId, input.conversationId),
        eq(structuredDataResources.id, input.structuredDataResourceId)
      )
    )
    .limit(1);
  return row ? mapStructuredDataResource(row) : undefined;
}

export async function listStructuredDataResources(
  db: PostgresDatabase,
  input: Parameters<StructuredDataStore["listStructuredDataResources"]>[0]
): Promise<StructuredDataResourceRecord[]> {
  const rows = await db
    .select()
    .from(structuredDataResources)
    .where(
      and(
        eq(structuredDataResources.clientInstanceId, input.clientInstanceId),
        eq(structuredDataResources.conversationId, input.conversationId)
      )
    )
    .orderBy(desc(structuredDataResources.updatedAt));
  return rows.map(mapStructuredDataResource);
}

export async function publishStructuredDataResource(
  db: PostgresDatabase,
  input: Parameters<StructuredDataStore["publishStructuredDataResource"]>[0]
): Promise<StructuredDataResourceRecord> {
  const now = new Date();
  const [row] = await db
    .insert(structuredDataResources)
    .values({
      id: createPlatformId("sdr"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      resourceKey: input.resourceKey,
      title: input.title,
      state: input.state,
      revision: 1,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        structuredDataResources.clientInstanceId,
        structuredDataResources.conversationId,
        structuredDataResources.resourceKey
      ],
      set: {
        title: input.title,
        state: input.state,
        revision: sql`${structuredDataResources.revision} + 1`,
        updatedAt: now
      }
    })
    .returning();
  return mapStructuredDataResource(row);
}
