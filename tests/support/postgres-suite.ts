import { beforeAllWithPostgres as beforeAll } from "./postgres-hooks";
import { fileTestDatabaseUrl } from "./test-database";
import postgres from "postgres";
import { afterAll, afterEach } from "vitest";
import { asClientInstanceId, type ClientInstanceId } from "@vivd-catalyst/core";
import { required } from "./assertions";
import {
  databaseUrlFor,
  holdTransaction,
  type HeldTransaction
} from "./postgres-concurrency-harness";
import { createTestInstance, type TestPostgresStore } from "./test-instance";

/**
 * What a suite on the test database works with: two store pools that Postgres can tell apart,
 * a connection for a transaction the test holds open, and a plain connection for reading and
 * arranging rows.
 */
export interface PostgresSuite {
  /** Application names of the two pools and of the barrier connection, as `pg_locks` sees them. */
  readonly first: string;
  readonly second: string;
  readonly barrier: string;
  readonly databaseUrl: string;
  readonly store: TestPostgresStore;
  readonly secondStore: TestPostgresStore;
  readonly barrierSql: postgres.Sql;
  readonly sql: postgres.Sql;
  /** A client instance of its own for one test. Its rows are removed after the test. */
  clientInstance(label: string): ClientInstanceId;
  /**
   * Opens a transaction on the barrier connection, runs `prepare` in it and keeps it open. It
   * is rolled back after the test if the test did not end it.
   */
  hold(prepare: Parameters<typeof holdTransaction>[1]): Promise<HeldTransaction>;
}

/**
 * Connects the suite to its isolated file database cloned from the migrated template and removes
 * what its tests wrote. The suite needs the database and fails without it. Call it in the
 * `describe` that holds the tests.
 */
export function usePostgresSuite(prefix: string): PostgresSuite {
  const name = `${prefix}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const first = `${name}_first`;
  const second = `${name}_second`;
  const barrier = `${name}_barrier`;
  const clientInstanceIds: ClientInstanceId[] = [];
  const heldTransactions: HeldTransaction[] = [];
  let databaseUrl: string | undefined;
  let store: TestPostgresStore | undefined;
  let secondStore: TestPostgresStore | undefined;
  let barrierSql: postgres.Sql | undefined;
  let sql: postgres.Sql | undefined;

  beforeAll(async () => {
    const url = await fileTestDatabaseUrl();
    databaseUrl = url;
    store = (
      await createTestInstance({
        postgres: { applicationName: first }
      })
    ).stores;
    secondStore = (
      await createTestInstance({
        postgres: { applicationName: second }
      })
    ).stores;
    barrierSql = postgres(databaseUrlFor(url, barrier), { max: 1 });
    sql = postgres(url, { max: 1 });
  });

  afterEach(async () => {
    for (const held of heldTransactions.splice(0)) {
      await held.rollback();
    }
    if (!sql) return;
    for (const clientInstanceId of clientInstanceIds.splice(0)) {
      await sql`delete from audit_events where client_instance_id = ${clientInstanceId}`;
      await sql`delete from run_start_commands where client_instance_id = ${clientInstanceId}`;
      await sql`delete from conversations where client_instance_id = ${clientInstanceId}`;
      await sql`delete from managed_files where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspace_memberships where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspaces where client_instance_id = ${clientInstanceId}`;
      await sql`delete from product_users where client_instance_id = ${clientInstanceId}`;
    }
  });

  afterAll(async () => {
    await sql?.end();
    await barrierSql?.end();
  });

  return {
    first,
    second,
    barrier,
    get databaseUrl() {
      return required(databaseUrl);
    },
    get store() {
      return required(store);
    },
    get secondStore() {
      return required(secondStore);
    },
    get barrierSql() {
      return required(barrierSql);
    },
    get sql() {
      return required(sql);
    },
    clientInstance(label) {
      const clientInstanceId = asClientInstanceId(`${name}_${label}`);
      clientInstanceIds.push(clientInstanceId);
      return clientInstanceId;
    },
    async hold(prepare) {
      const held = await holdTransaction(required(barrierSql), prepare);
      heldTransactions.push(held);
      return held;
    }
  };
}
