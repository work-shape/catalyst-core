import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type {
  CapabilityRecord,
  CapabilityRecordStore,
  ClientInstanceId
} from "@work-shape/catalyst-core";
import { type PostgresConnection } from "./postgres-database";
import { capabilityRecords } from "./schema/capabilityRecords";

type Row = typeof capabilityRecords.$inferSelect;
type Input<Method extends keyof CapabilityRecordStore> = Parameters<
  CapabilityRecordStore[Method]
>[0];

/** The most records one claim moves. */
const CLAIM_LIMIT_MAX = 100;

function named(input: { clientInstanceId: ClientInstanceId; capability: string; kind: string }) {
  return and(
    eq(capabilityRecords.clientInstanceId, input.clientInstanceId),
    eq(capabilityRecords.capability, input.capability),
    eq(capabilityRecords.kind, input.kind)
  );
}

function mapRecord(row: Row): CapabilityRecord {
  return {
    capability: row.capability,
    kind: row.kind,
    id: row.id,
    ...(row.key === null ? {} : { key: row.key }),
    status: row.status,
    document: row.document,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {})
  };
}

async function createRecord(
  db: PostgresConnection,
  input: Input<"create">
): Promise<CapabilityRecord | undefined> {
  const at = new Date(input.at);
  const [row] = await db
    .insert(capabilityRecords)
    .values({
      clientInstanceId: input.clientInstanceId,
      capability: input.capability,
      kind: input.kind,
      id: input.id,
      key: input.key ?? null,
      status: input.status,
      document: input.document,
      createdAt: at,
      updatedAt: at,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null
    })
    .onConflictDoNothing()
    .returning();
  return row ? mapRecord(row) : undefined;
}

async function getRecord(db: PostgresConnection, input: Input<"get">) {
  const [row] = await db
    .select()
    .from(capabilityRecords)
    .where(and(named(input), eq(capabilityRecords.id, input.id)));
  return row ? mapRecord(row) : undefined;
}

async function getRecordByKey(db: PostgresConnection, input: Input<"getByKey">) {
  const [row] = await db
    .select()
    .from(capabilityRecords)
    .where(and(named(input), eq(capabilityRecords.key, input.key)));
  return row ? mapRecord(row) : undefined;
}

async function updateRecord(db: PostgresConnection, input: Input<"update">) {
  const [row] = await db
    .update(capabilityRecords)
    .set({
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.document === undefined ? {} : { document: input.document }),
      ...(input.expiresAt === undefined
        ? {}
        : { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }),
      version: sql`${capabilityRecords.version} + 1`,
      updatedAt: new Date(input.at)
    })
    .where(
      and(
        named(input),
        eq(capabilityRecords.id, input.id),
        input.version === undefined ? undefined : eq(capabilityRecords.version, input.version)
      )
    )
    .returning();
  return row ? mapRecord(row) : undefined;
}

async function claimRecords(db: PostgresConnection, input: Input<"claim">) {
  const limit = Math.max(1, Math.min(CLAIM_LIMIT_MAX, Math.floor(input.limit)));
  const due = and(
    named(input),
    eq(capabilityRecords.status, input.status),
    input.expiresBefore === undefined
      ? undefined
      : and(
          isNotNull(capabilityRecords.expiresAt),
          lt(capabilityRecords.expiresAt, new Date(input.expiresBefore))
        )
  );
  const picked = db
    .select({ id: capabilityRecords.id })
    .from(capabilityRecords)
    .where(due)
    .orderBy(asc(capabilityRecords.expiresAt), asc(capabilityRecords.updatedAt))
    .limit(limit);
  // The status is asked again by the update itself: of two claims that picked the same record,
  // the second waits for the first's write and then finds the status moved, so only one gets it.
  const rows = await db
    .update(capabilityRecords)
    .set({
      status: input.toStatus,
      version: sql`${capabilityRecords.version} + 1`,
      updatedAt: new Date(input.at)
    })
    .where(and(due, inArray(capabilityRecords.id, picked)))
    .returning();
  return rows.map((row) => ({
    ...mapRecord(row),
    status: input.status,
    version: row.version - 1
  }));
}

async function deleteExpiredRecords(db: PostgresConnection, input: Input<"deleteExpired">) {
  const deleted = await db
    .delete(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.clientInstanceId, input.clientInstanceId),
        eq(capabilityRecords.capability, input.capability),
        isNotNull(capabilityRecords.expiresAt),
        lt(capabilityRecords.expiresAt, new Date(input.before))
      )
    )
    .returning({ id: capabilityRecords.id });
  return deleted.length;
}

export function createPostgresCapabilityRecordStore(db: PostgresConnection): CapabilityRecordStore {
  return {
    create: (input) => createRecord(db, input),
    get: (input) => getRecord(db, input),
    getByKey: (input) => getRecordByKey(db, input),
    update: (input) => updateRecord(db, input),
    claim: (input) => claimRecords(db, input),
    deleteExpired: (input) => deleteExpiredRecords(db, input)
  };
}
