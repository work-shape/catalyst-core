import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  ConnectionStateRecord,
  ConnectionsStore,
  StoredSecretRecord
} from "@work-shape/catalyst-core";
import { createPostgresConnectionBindingOperations } from "./postgres-connection-binding-operations";
import type { PostgresConnection } from "./postgres-database";
import { connectionState, secrets } from "./schema";

type SecretRow = typeof secrets.$inferSelect;
type StateRow = typeof connectionState.$inferSelect;

function mapSecret(row: SecretRow): StoredSecretRecord {
  return {
    handle: row.handle,
    clientInstanceId: row.clientInstanceId,
    connectionAssetId: row.connectionAssetId,
    subject: row.subject,
    version: row.version,
    keyId: row.keyId,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    source: row.source,
    ...(row.origin === null ? {} : { origin: row.origin })
  };
}

function mapState(row: StateRow): ConnectionStateRecord {
  return {
    connectionAssetId: row.connectionAssetId,
    clientInstanceId: row.clientInstanceId,
    health: row.health,
    ...(row.lastTestedAt ? { lastTestedAt: row.lastTestedAt.toISOString() } : {}),
    ...(row.lastErrorCode === null ? {} : { lastErrorCode: row.lastErrorCode }),
    ...(row.catalog === null ? {} : { catalog: row.catalog }),
    ...(row.oauthClient === null ? {} : { oauthClient: row.oauthClient }),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** The only code that reads or writes `secrets` and `connection_state`. */
export function createPostgresConnectionsStore(db: PostgresConnection): ConnectionsStore {
  return {
    ...createPostgresConnectionBindingOperations(db),
    async lockReleaseSeed({ clientInstanceId }) {
      // Held until the transaction ends. Outside of one it would be released at once, which
      // the caller's use inside `transaction` rules out.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`connections_release_seed:${clientInstanceId}`}, 0))`
      );
    },
    async getSecret({ clientInstanceId, handle }) {
      const [row] = await db
        .select()
        .from(secrets)
        .where(and(eq(secrets.clientInstanceId, clientInstanceId), eq(secrets.handle, handle)))
        .limit(1);
      return row ? mapSecret(row) : undefined;
    },
    async findSecret({ clientInstanceId, binding }) {
      const [row] = await db
        .select()
        .from(secrets)
        .where(
          and(
            eq(secrets.clientInstanceId, clientInstanceId),
            eq(secrets.connectionAssetId, binding.connectionAssetId),
            eq(secrets.subject, binding.subject)
          )
        )
        .limit(1);
      return row ? mapSecret(row) : undefined;
    },
    async putSecret(record) {
      const sealed = {
        version: record.version,
        keyId: record.keyId,
        nonce: record.nonce,
        ciphertext: record.ciphertext,
        source: record.source,
        origin: record.origin ?? null
      };
      // Version 1 is only ever inserted and a later version only ever replaces the one before
      // it, each in one statement: a version above 1 that finds the row gone writes nothing,
      // so a write that read a row before a delete cannot put it back.
      const written =
        record.version === 1
          ? await db
              .insert(secrets)
              .values({
                handle: record.handle,
                clientInstanceId: record.clientInstanceId,
                connectionAssetId: record.connectionAssetId,
                subject: record.subject,
                ...sealed,
                createdAt: sql`now()`,
                updatedAt: sql`now()`
              })
              .onConflictDoNothing()
              .returning({ handle: secrets.handle })
          : await db
              .update(secrets)
              .set({ ...sealed, updatedAt: sql`now()` })
              .where(
                and(
                  eq(secrets.clientInstanceId, record.clientInstanceId),
                  eq(secrets.connectionAssetId, record.connectionAssetId),
                  eq(secrets.subject, record.subject),
                  eq(secrets.version, record.version - 1),
                  // A secret set on the instance is never replaced from the environment.
                  ...(record.source === "bootstrap" ? [eq(secrets.source, "bootstrap")] : [])
                )
              )
              .returning({ handle: secrets.handle });
      return written.length > 0;
    },
    async deleteSecrets({ clientInstanceId, connectionAssetId, subject, source }) {
      await db
        .delete(secrets)
        .where(
          and(
            eq(secrets.clientInstanceId, clientInstanceId),
            eq(secrets.connectionAssetId, connectionAssetId),
            ...(subject === undefined ? [] : [eq(secrets.subject, subject)]),
            ...(source === undefined ? [] : [eq(secrets.source, source)])
          )
        );
    },
    async getConnectionState({ clientInstanceId, connectionAssetId }) {
      const [row] = await db
        .select()
        .from(connectionState)
        .where(
          and(
            eq(connectionState.clientInstanceId, clientInstanceId),
            eq(connectionState.connectionAssetId, connectionAssetId)
          )
        )
        .limit(1);
      return row ? mapState(row) : undefined;
    },
    async listConnectionStates({ clientInstanceId, connectionAssetIds }) {
      if (connectionAssetIds?.length === 0) return [];
      const rows = await db
        .select()
        .from(connectionState)
        .where(
          and(
            eq(connectionState.clientInstanceId, clientInstanceId),
            connectionAssetIds === undefined
              ? undefined
              : inArray(connectionState.connectionAssetId, [...connectionAssetIds])
          )
        )
        .orderBy(asc(connectionState.connectionAssetId));
      return rows.map(mapState);
    },
    async putConnectionState(input) {
      const named = {
        ...(input.lastTestedAt === undefined ? {} : { lastTestedAt: new Date(input.lastTestedAt) }),
        ...(input.lastErrorCode === undefined ? {} : { lastErrorCode: input.lastErrorCode }),
        ...(input.catalog === undefined ? {} : { catalog: input.catalog })
      };
      await db
        .insert(connectionState)
        .values({
          connectionAssetId: input.connectionAssetId,
          clientInstanceId: input.clientInstanceId,
          health: input.health,
          ...named,
          updatedAt: sql`now()`
        })
        .onConflictDoUpdate({
          target: connectionState.connectionAssetId,
          set: { health: input.health, ...named, updatedAt: sql`now()` }
        });
    },
    async putConnectionOAuthClient({ clientInstanceId, connectionAssetId, oauthClient }) {
      await db
        .insert(connectionState)
        .values({
          connectionAssetId,
          clientInstanceId,
          health: "needs_configuration",
          oauthClient,
          updatedAt: sql`now()`
        })
        .onConflictDoUpdate({
          target: connectionState.connectionAssetId,
          set: { oauthClient, updatedAt: sql`now()` }
        });
    },
    async deleteConnectionState({ clientInstanceId, connectionAssetId }) {
      await db
        .delete(connectionState)
        .where(
          and(
            eq(connectionState.clientInstanceId, clientInstanceId),
            eq(connectionState.connectionAssetId, connectionAssetId)
          )
        );
    }
  };
}
