import { and, asc, eq, sql } from "drizzle-orm";
import type {
  ConnectionStateRecord,
  ConnectionsStore,
  StoredSecretRecord
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { connectionState, secrets } from "../schema";

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
    updatedAt: row.updatedAt.toISOString()
  };
}

/** The only code that reads or writes `secrets` and `connection_state`. */
export function createPostgresConnectionsStore(db: PostgresConnection): ConnectionsStore {
  return {
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
      const values = {
        handle: record.handle,
        clientInstanceId: record.clientInstanceId,
        connectionAssetId: record.connectionAssetId,
        subject: record.subject,
        version: record.version,
        keyId: record.keyId,
        nonce: record.nonce,
        ciphertext: record.ciphertext,
        source: record.source,
        origin: record.origin ?? null
      };
      const written = await db
        .insert(secrets)
        .values({ ...values, createdAt: sql`now()`, updatedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [secrets.connectionAssetId, secrets.subject],
          set: {
            version: record.version,
            keyId: record.keyId,
            nonce: record.nonce,
            ciphertext: record.ciphertext,
            source: record.source,
            origin: record.origin ?? null,
            updatedAt: sql`now()`
          },
          // One statement decides: the row is replaced only by the version that follows the
          // stored one. Of two writers of the same next version one finds the row changed.
          setWhere: sql`${secrets.version} = ${record.version} - 1`
        })
        .returning({ handle: secrets.handle });
      return written.length > 0;
    },
    async deleteSecrets({ clientInstanceId, connectionAssetId, subject }) {
      await db
        .delete(secrets)
        .where(
          and(
            eq(secrets.clientInstanceId, clientInstanceId),
            eq(secrets.connectionAssetId, connectionAssetId),
            ...(subject === undefined ? [] : [eq(secrets.subject, subject)])
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
    async listConnectionStates({ clientInstanceId }) {
      const rows = await db
        .select()
        .from(connectionState)
        .where(eq(connectionState.clientInstanceId, clientInstanceId))
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
