import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  isNotNull,
  ne,
  isNull,
  lt,
  lte,
  or,
  sql
} from "drizzle-orm";
import type {
  ConnectionBindingKey,
  ConnectionBindingRecord,
  ConnectionBindingsStore,
  ConnectionSetupSessionRecord
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { connectionBindings, connectionSetupSessions } from "./schema";

// The rows of sign-in bindings and setup sessions. Every decision about time is the database
// clock's at the statement (`clock_timestamp()`), so a lease or an expiry reads the same in
// every process and inside a transaction that started earlier.

type BindingRow = typeof connectionBindings.$inferSelect;
type SessionRow = typeof connectionSetupSessions.$inferSelect;

const statementTime = sql`clock_timestamp()`;
const later = (ms: number) =>
  sql`clock_timestamp() + make_interval(secs => ${ms}::double precision / 1000)`;

function mapBinding(row: BindingRow): ConnectionBindingRecord {
  if (row.scheme !== "oauth" || row.secretHandle === null || row.secretVersion === null) {
    throw new Error("Expected an OAuth binding");
  }
  return {
    clientInstanceId: row.clientInstanceId,
    connectionAssetId: row.connectionAssetId,
    subject: row.subject,
    ...(row.userId === null ? {} : { userId: row.userId }),
    state: row.state,
    scheme: row.scheme,
    ...(row.accountId === null ? {} : { accountId: row.accountId }),
    ...(row.accountLabel === null ? {} : { accountLabel: row.accountLabel }),
    grantedScopes: row.grantedScopes,
    secretHandle: row.secretHandle,
    secretVersion: row.secretVersion,
    ...(row.accessExpiresAt ? { accessExpiresAt: row.accessExpiresAt.toISOString() } : {}),
    ...(row.lastRefreshedAt ? { lastRefreshedAt: row.lastRefreshedAt.toISOString() } : {}),
    connectedAt: row.connectedAt.toISOString(),
    ...(row.connectedBy === null ? {} : { connectedBy: row.connectedBy }),
    ...(row.lastUsedOn === null ? {} : { lastUsedOn: row.lastUsedOn }),
    stateChangedAt: row.stateChangedAt.toISOString(),
    ...(row.stateChangedBy === null ? {} : { stateChangedBy: row.stateChangedBy }),
    ...(row.stateReason === null ? {} : { stateReason: row.stateReason }),
    origin: row.origin,
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt.toISOString() } : {}),
    rowVersion: row.rowVersion
  };
}

/** The session of a row, or nothing for a row without the resource or client it was started with. */
function mapSession(row: SessionRow): ConnectionSetupSessionRecord | undefined {
  if (row.resource === null || row.clientId === null) return undefined;
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    connectionAssetId: row.connectionAssetId,
    connectionRevision: row.connectionRevision,
    subject: row.subject,
    actorUserId: row.actorUserId,
    authSessionId: row.authSessionId,
    stateHash: row.stateHash,
    verifier: {
      keyId: row.verifierKeyId,
      nonce: row.verifierNonce,
      ciphertext: row.verifierCiphertext
    },
    redirectUri: row.redirectUri,
    issuer: row.issuer,
    resource: row.resource,
    clientId: row.clientId,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString()
  };
}

const bindingOf = (key: ConnectionBindingKey) =>
  and(
    eq(connectionBindings.clientInstanceId, key.clientInstanceId),
    eq(connectionBindings.connectionAssetId, key.connectionAssetId),
    eq(connectionBindings.subject, key.subject)
  );

/** The only code that reads or writes `connection_bindings` and `connection_setup_sessions`. */
export function createPostgresConnectionBindingOperations(
  db: PostgresConnection
): ConnectionBindingsStore {
  const oauthBindingOf = (key: ConnectionBindingKey) =>
    and(bindingOf(key), eq(connectionBindings.scheme, "oauth"));
  return {
    async revokeConnectionPersonContexts(input) {
      await db
        .update(connectionBindings)
        .set({
          contextValue: null,
          state: "revoked",
          stateChangedAt: statementTime,
          rowVersion: sql`${connectionBindings.rowVersion} + 1`
        })
        .where(
          and(
            eq(connectionBindings.clientInstanceId, input.clientInstanceId),
            eq(connectionBindings.connectionAssetId, input.connectionAssetId),
            eq(connectionBindings.scheme, "person_context"),
            isNotNull(connectionBindings.contextValue),
            input.origin === undefined || input.header === undefined
              ? undefined
              : or(
                  ne(connectionBindings.origin, input.origin),
                  ne(connectionBindings.contextHeader, input.header)
                )
          )
        );
    },
    async getConnectionPersonContext(key) {
      const [row] = await db
        .select()
        .from(connectionBindings)
        .where(and(bindingOf(key), eq(connectionBindings.scheme, "person_context")))
        .limit(1);
      if (!row || row.contextHeader === null) return undefined;
      return {
        ...key,
        origin: row.origin,
        header: row.contextHeader,
        value: row.contextValue,
        rowVersion: row.rowVersion
      };
    },
    async setConnectionPersonContext(input) {
      const { expectedRowVersion, value } = input;
      const where = and(
        bindingOf(input),
        eq(connectionBindings.scheme, "person_context"),
        eq(connectionBindings.rowVersion, expectedRowVersion ?? 0)
      );
      const values = {
        scheme: "person_context" as const,
        state: value === null ? ("revoked" as const) : ("connected" as const),
        contextHeader: input.header,
        contextValue: value,
        origin: input.origin,
        grantedScopes: [],
        secretHandle: null,
        secretVersion: null,
        connectedAt: statementTime,
        connectedBy: input.changedBy,
        stateChangedAt: statementTime,
        stateChangedBy: input.changedBy
      };
      if (expectedRowVersion === null) {
        const rows = await db
          .insert(connectionBindings)
          .values({
            clientInstanceId: input.clientInstanceId,
            connectionAssetId: input.connectionAssetId,
            subject: input.subject,
            ...values,
            rowVersion: 1
          })
          .onConflictDoNothing()
          .returning({ subject: connectionBindings.subject });
        return rows.length === 1;
      }
      const rows = await db
        .update(connectionBindings)
        .set({ ...values, rowVersion: sql`${connectionBindings.rowVersion} + 1` })
        .where(where)
        .returning({ subject: connectionBindings.subject });
      return rows.length === 1;
    },
    async getConnectionBinding(key) {
      const [row] = await db.select().from(connectionBindings).where(oauthBindingOf(key)).limit(1);
      return row ? mapBinding(row) : undefined;
    },
    async connectConnectionBinding({ expectedRowVersion, ...signIn }) {
      const values = {
        userId: signIn.userId ?? null,
        state: "connected" as const,
        scheme: signIn.scheme,
        accountId: signIn.accountId ?? null,
        accountLabel: signIn.accountLabel ?? null,
        grantedScopes: [...signIn.grantedScopes],
        secretHandle: signIn.secretHandle,
        secretVersion: signIn.secretVersion,
        accessExpiresAt: signIn.accessExpiresAt ? new Date(signIn.accessExpiresAt) : null,
        lastRefreshedAt: null,
        connectedAt: statementTime,
        connectedBy: signIn.connectedBy ?? null,
        stateChangedAt: statementTime,
        stateChangedBy: signIn.connectedBy ?? null,
        stateReason: null,
        origin: signIn.origin
      };
      if (expectedRowVersion === null) {
        const [row] = await db
          .insert(connectionBindings)
          .values({
            clientInstanceId: signIn.clientInstanceId,
            connectionAssetId: signIn.connectionAssetId,
            subject: signIn.subject,
            ...values,
            rowVersion: 1
          })
          .onConflictDoNothing()
          .returning();
        return row ? mapBinding(row) : undefined;
      }
      // A new sign-in replaces the binding whole. The last use and the lease stay: whoever
      // holds the lease finds the row version changed and uses what is stored now.
      const [row] = await db
        .update(connectionBindings)
        .set({ ...values, rowVersion: sql`${connectionBindings.rowVersion} + 1` })
        .where(and(oauthBindingOf(signIn), eq(connectionBindings.rowVersion, expectedRowVersion)))
        .returning();
      return row ? mapBinding(row) : undefined;
    },
    async changeConnectionBindingState({ expectedRowVersion, state, reason, changedBy, ...key }) {
      const [row] = await db
        .update(connectionBindings)
        .set({
          state,
          stateReason: reason,
          stateChangedBy: changedBy ?? null,
          stateChangedAt: statementTime,
          rowVersion: sql`${connectionBindings.rowVersion} + 1`
        })
        .where(and(oauthBindingOf(key), eq(connectionBindings.rowVersion, expectedRowVersion)))
        .returning();
      return row ? mapBinding(row) : undefined;
    },
    async takeConnectionBindingLease({ owner, leaseMs, ...key }) {
      // One statement decides: of two processes that ask at once, the second one's update
      // waits for the first one's row lock and then finds the lease taken.
      const [row] = await db
        .update(connectionBindings)
        .set({ leaseOwner: owner, leaseExpiresAt: later(leaseMs) })
        .where(
          and(
            oauthBindingOf(key),
            or(
              isNull(connectionBindings.leaseOwner),
              lte(connectionBindings.leaseExpiresAt, statementTime),
              eq(connectionBindings.leaseOwner, owner)
            )
          )
        )
        .returning();
      return row ? mapBinding(row) : undefined;
    },
    async releaseConnectionBindingLease({ owner, ...key }) {
      const released = await db
        .update(connectionBindings)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(and(oauthBindingOf(key), eq(connectionBindings.leaseOwner, owner)))
        .returning({ subject: connectionBindings.subject });
      return released.length > 0;
    },
    async refreshConnectionBinding({
      owner,
      expectedRowVersion,
      secretVersion,
      grantedScopes,
      accessExpiresAt,
      ...key
    }) {
      const [row] = await db
        .update(connectionBindings)
        .set({
          secretVersion,
          grantedScopes: [...grantedScopes],
          accessExpiresAt: accessExpiresAt === null ? null : new Date(accessExpiresAt),
          lastRefreshedAt: statementTime,
          rowVersion: sql`${connectionBindings.rowVersion} + 1`
        })
        .where(
          and(
            oauthBindingOf(key),
            eq(connectionBindings.state, "connected"),
            eq(connectionBindings.rowVersion, expectedRowVersion),
            eq(connectionBindings.leaseOwner, owner)
          )
        )
        .returning();
      return row ? mapBinding(row) : undefined;
    },
    async noteConnectionBindingUse(key) {
      // A day is the database's, as every other time of the row.
      await db
        .update(connectionBindings)
        .set({ lastUsedOn: sql`current_date` })
        .where(
          and(
            oauthBindingOf(key),
            or(
              isNull(connectionBindings.lastUsedOn),
              lt(connectionBindings.lastUsedOn, sql`current_date`)
            )
          )
        );
    },
    async listIdleConnectionBindings({ clientInstanceId, subject, idleMs, limit }) {
      // The latest of the three moments a binding was last kept alive. A day of use counts
      // from its start, so a binding used today is idle for no keep-alive.
      const lastAlive = sql`greatest(
        ${connectionBindings.connectedAt},
        coalesce(${connectionBindings.lastRefreshedAt}, ${connectionBindings.connectedAt}),
        coalesce(${connectionBindings.lastUsedOn}::timestamptz, ${connectionBindings.connectedAt})
      )`;
      const rows = await db
        .select()
        .from(connectionBindings)
        .where(
          and(
            eq(connectionBindings.clientInstanceId, clientInstanceId),
            eq(connectionBindings.subject, subject),
            eq(connectionBindings.state, "connected"),
            eq(connectionBindings.scheme, "oauth"),
            lte(
              lastAlive,
              sql`clock_timestamp() - make_interval(secs => ${idleMs}::double precision / 1000)`
            )
          )
        )
        .orderBy(asc(lastAlive))
        .limit(limit);
      return rows.map(mapBinding);
    },
    async createConnectionSetupSession({ ttlMs, verifier, ...session }) {
      const [row] = await db
        .insert(connectionSetupSessions)
        .values({
          ...session,
          verifierKeyId: verifier.keyId,
          verifierNonce: verifier.nonce,
          verifierCiphertext: verifier.ciphertext,
          createdAt: statementTime,
          expiresAt: later(ttlMs)
        })
        .returning();
      const stored = row ? mapSession(row) : undefined;
      if (!stored) throw new Error("The setup session was not stored");
      return stored;
    },
    async consumeConnectionSetupSession({ clientInstanceId, stateHash }) {
      // The delete is the one decision: of two callbacks with the same state, one gets the row.
      const [row] = await db
        .delete(connectionSetupSessions)
        .where(
          and(
            eq(connectionSetupSessions.clientInstanceId, clientInstanceId),
            eq(connectionSetupSessions.stateHash, stateHash)
          )
        )
        .returning({
          ...getTableColumns(connectionSetupSessions),
          expired: sql<boolean>`${connectionSetupSessions.expiresAt} <= ${statementTime}`
        });
      if (!row) return { outcome: "unknown" };
      const { expired, ...session } = row;
      if (expired) return { outcome: "expired" };
      const consumed = mapSession(session);
      // A session started before the release that stores its resource cannot be completed.
      return consumed ? { outcome: "consumed", session: consumed } : { outcome: "expired" };
    },
    async readWaitingConnectionSetupSession({ clientInstanceId, id }) {
      const [row] = await db
        .select({
          connectionAssetId: connectionSetupSessions.connectionAssetId,
          actorUserId: connectionSetupSessions.actorUserId
        })
        .from(connectionSetupSessions)
        .where(
          and(
            eq(connectionSetupSessions.clientInstanceId, clientInstanceId),
            eq(connectionSetupSessions.id, id),
            gt(connectionSetupSessions.expiresAt, statementTime)
          )
        );
      return row;
    },
    async sweepExpiredConnectionSetupSessions({ clientInstanceId }) {
      // Sessions are made by people who connect a Connection and live 15 minutes, so the
      // expired ones of one tick are few; the index on (instance, expiry) finds them.
      const swept = await db
        .delete(connectionSetupSessions)
        .where(
          and(
            eq(connectionSetupSessions.clientInstanceId, clientInstanceId),
            lte(connectionSetupSessions.expiresAt, statementTime)
          )
        )
        .returning({ id: connectionSetupSessions.id });
      return swept.length;
    }
  };
}
