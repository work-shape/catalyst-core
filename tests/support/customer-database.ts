import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import postgres from "postgres";
import { afterAll, expect } from "vitest";
import { PostgresExecutorError } from "@vivd-catalyst/postgres-connector";
import { required } from "./assertions";
import { beforeAllWithPostgres as beforeAll } from "./postgres-hooks";
import { fileTestDatabaseUrl } from "./test-database";

/**
 * The file database dressed as a database a customer runs: a `reporting` schema with a few
 * tables, and two accounts. The reader may only read. The writer may also insert into
 * `reporting.visits`, has a connection limit of 7 and a statement timeout of 45 seconds.
 */
export interface CustomerDatabase {
  readonly reader: string;
  readonly writer: string;
  /** Password by the name a test resolves it under. */
  readonly passwords: ReadonlyMap<string, string>;
  /** The name a customer would configure. It resolves nowhere: only `address` leads there. */
  readonly host: string;
  readonly address: string;
  readonly port: number;
  readonly database: string;
  /** The customer's own administrator, for arranging rows and looking at the server. */
  readonly sql: postgres.Sql;
  /** The backends of one account, as the customer's server sees them. */
  backends(user: string): Promise<{ pid: number; state: string; query: string }[]>;
  /** The backend that runs the query with this comment in it, once it does. */
  runningQuery(user: string, comment: string): Promise<number>;
  /** True once the server has ended the backend, which a sleeping query alone would not allow. */
  ended(user: string, pid: number): Promise<boolean>;
}

export function useCustomerDatabase(): CustomerDatabase {
  const run = randomUUID().slice(0, 8);
  const reader = `pgx_reader_${run}`;
  const writer = `pgx_writer_${run}`;
  const passwords = new Map([
    ["reader-password", `reader-${randomUUID()}`],
    ["writer-password", `writer-${randomUUID()}`]
  ]);
  let url: URL | undefined;
  let address: string | undefined;
  let admin: postgres.Sql | undefined;

  beforeAll(async () => {
    url = new URL(await fileTestDatabaseUrl());
    address = (await lookup(url.hostname, { family: 4 })).address;
    admin = postgres(url.toString(), { max: 1, onnotice() {} });
    await admin.unsafe(`
      create schema reporting;
      create table reporting.orders (
        id bigint primary key,
        customer text not null,
        amount numeric(12, 2) not null,
        placed_on date not null,
        placed_at timestamptz not null,
        tags text[] not null
      );
      comment on table reporting.orders is 'Orders of the shop';
      comment on column reporting.orders.customer is 'Who ordered';
      create table reporting.order_lines (
        id bigint primary key,
        order_id bigint not null references reporting.orders (id),
        sku text not null
      );
      create table reporting.visits (id bigint generated always as identity, note text);
      create function reporting.record_visit() returns bigint language sql as
        $$ insert into reporting.visits (note) values ('visit') returning id $$;
      create function reporting.noisy() returns integer language plpgsql as
        $$ begin raise notice 'row value %', 'customer-secret-17'; return 1; end $$;
      insert into reporting.orders values
        (1, 'Ada Lovelace', 19.90, '2024-05-01', '2024-05-01 10:00:00+00', '{"new","b\\"c"}'),
        (2, 'Grace Hopper', 5.00, '2024-05-02', '2024-05-02 12:30:00.5+02', '{}');
      create role ${reader} login password '${required(passwords.get("reader-password"))}';
      create role ${writer} login connection limit 7
        password '${required(passwords.get("writer-password"))}';
      alter role ${writer} set statement_timeout = '45s';
      grant usage on schema reporting to ${reader}, ${writer};
      grant select on all tables in schema reporting to ${reader}, ${writer};
      grant insert on reporting.visits to ${writer};
    `);
  });

  // Roles belong to the server, not to the file database, so they are removed here.
  afterAll(async () => {
    await admin?.unsafe(`drop owned by ${reader}, ${writer}; drop role ${reader}, ${writer};`);
    await admin?.end();
  });

  const customer: CustomerDatabase = {
    reader,
    writer,
    passwords,
    host: "warehouse.customer.example",
    get address() {
      return required(address);
    },
    get port() {
      return Number(required(url).port);
    },
    get database() {
      return required(url).pathname.slice(1);
    },
    get sql() {
      return required(admin);
    },
    backends: (user) => required(admin)`
      select pid, state, query from pg_stat_activity where usename = ${user}
    `,
    async runningQuery(user, comment) {
      let pid: number | undefined;
      await expect
        .poll(
          async () => {
            pid = (await customer.backends(user)).find(
              (backend) => backend.state === "active" && backend.query.includes(comment)
            )?.pid;
            return pid;
          },
          { timeout: 6000 }
        )
        .toBeTypeOf("number");
      return required(pid);
    },
    ended: async (user, pid) =>
      (await customer.backends(user)).every((backend) => backend.pid !== pid)
  };
  return customer;
}

/** The executor error a call failed with. Anything else a call threw is thrown on. */
export async function executorFailure(call: Promise<unknown>): Promise<PostgresExecutorError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof PostgresExecutorError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail");
}
