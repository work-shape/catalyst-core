import { and, desc, eq, sql } from "drizzle-orm";
import {
  createPlatformId,
  type StructuredDataResourceRecord,
  type StructuredDataStore
} from "@work-shape/catalyst-core";
import { type PostgresConnection } from "./postgres-database";
import { mapStructuredDataResource } from "./rows";
import { structuredDataResources } from "./schema";

async function getStructuredDataResource(
  db: PostgresConnection,
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

async function listStructuredDataResources(
  db: PostgresConnection,
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
    .orderBy(desc(structuredDataResources.updatedAt), desc(structuredDataResources.id));
  return rows.map(mapStructuredDataResource);
}

async function publishStructuredDataResource(
  db: PostgresConnection,
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

export function createPostgresStructuredDataStore(db: PostgresConnection): StructuredDataStore {
  return {
    async getStructuredDataResource(
      input: Parameters<StructuredDataStore["getStructuredDataResource"]>[0]
    ): Promise<StructuredDataResourceRecord | undefined> {
      return getStructuredDataResource(db, input);
    },
    async listStructuredDataResources(
      input: Parameters<StructuredDataStore["listStructuredDataResources"]>[0]
    ): Promise<StructuredDataResourceRecord[]> {
      return listStructuredDataResources(db, input);
    },
    async publishStructuredDataResource(
      input: Parameters<StructuredDataStore["publishStructuredDataResource"]>[0]
    ): Promise<StructuredDataResourceRecord> {
      return publishStructuredDataResource(db, input);
    }
  };
}
