import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresExecutor,
  POSTGRES_READ_MARGIN_BYTES,
  POSTGRES_RESULT_MAX_BYTES,
  type PostgresExecutor,
  type PostgresLocation,
  type PostgresTarget
} from "@vivd-catalyst/postgres-connector";
import { required } from "./support/assertions";
import { executorFailure as failure, useCustomerDatabase } from "./support/customer-database";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { startPostgresRelay, type PostgresRelay } from "./support/postgres-relay";

/** What can be on its way between the server and a socket that has just been closed. */
const SLACK = 8_000_000;

describe("Postgres executor guards", () => {
  const customer = useCustomerDatabase();
  const { reader, writer, host } = customer;
  let slowCredentialMs = 0;
  /** From which socket on the address check never answers. */
  let addressCheckHangsFrom = Number.POSITIVE_INFINITY;
  let addressChecks = 0;
  let relay: PostgresRelay | undefined;
  const executors: PostgresExecutor[] = [];

  function newExecutor(): PostgresExecutor {
    const executor = createPostgresExecutor({
      secrets: {
        async getSecret(name) {
          await delay(slowCredentialMs);
          return customer.passwords.get(name);
        }
      },
      pinAddress() {
        addressChecks += 1;
        if (addressChecks >= addressCheckHangsFrom) return new Promise(() => undefined);
        return Promise.resolve({ allowed: true, address: customer.address });
      }
    });
    executors.push(executor);
    return executor;
  }
  const calls = () => required(executors[0]);
  const on = (
    user: string,
    credentialHandle: string,
    place: Partial<PostgresLocation> = {}
  ): PostgresTarget => ({
    location: {
      host,
      port: customer.port,
      database: customer.database,
      user,
      tls: "off",
      schemas: ["reporting"],
      ...place
    },
    credentialHandle
  });
  const asReader = (place?: Partial<PostgresLocation>) => on(reader, "reader-password", place);
  const asWriter = () => on(writer, "writer-password");

  beforeAll(async () => {
    relay = await startPostgresRelay({ host: customer.address, port: customer.port });
    newExecutor();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    slowCredentialMs = 0;
    addressCheckHangsFrom = Number.POSITIVE_INFINITY;
  });

  afterAll(async () => {
    await Promise.all(executors.map((executor) => executor.close()));
    await relay?.close();
  });

  describe("bytes read from the socket", () => {
    it("ends a call whose one value is far larger than the byte cap, long before it has arrived", async () => {
      const throughRelay = asReader({ port: required(relay).port });
      const before = required(relay).bytesFromServer();

      const result = await calls().query({
        ...throughRelay,
        sql: "select repeat('x', 200000000) as huge /* two hundred megabytes */"
      });

      expect(result).toEqual({
        columns: [{ name: "huge", type: "text" }],
        rows: [],
        rowCount: 0,
        truncated: true,
        truncatedBy: "bytes"
      });
      // What the relay took from the server bounds what the executor can have read and held.
      // Beyond the limit it is what was on the way when the socket closed.
      const read = required(relay).bytesFromServer() - before;
      expect(read).toBeGreaterThan(POSTGRES_RESULT_MAX_BYTES);
      expect(read).toBeLessThan(POSTGRES_RESULT_MAX_BYTES + POSTGRES_READ_MARGIN_BYTES + SLACK);
      await expect.poll(() => customer.backends(reader), { timeout: 5000 }).toEqual([]);
      expect(await calls().query({ ...throughRelay, sql: "select 1 as one" })).toMatchObject({
        rows: [{ one: 1 }]
      });
    });

    it("counts against the cap a caller lowered", async () => {
      const throughRelay = asReader({ port: required(relay).port });
      const before = required(relay).bytesFromServer();

      const result = await calls().query({
        ...throughRelay,
        limits: { maxBytes: 1000 },
        sql: "select repeat('x', 150000000) as large"
      });

      expect(result).toMatchObject({ rows: [], truncatedBy: "bytes" });
      expect(required(relay).bytesFromServer() - before).toBeLessThan(
        POSTGRES_READ_MARGIN_BYTES + SLACK
      );
    });

    it("fails a call that is not a query when it reads past the limit", async () => {
      await customer.sql.unsafe(`
        create schema wide;
        grant usage on schema wide to ${reader};
        create table wide.documents (id bigint);
        grant select on wide.documents to ${reader};
        comment on table wide.documents is '${"long ".repeat(4_000_000)}';
      `);

      const error = await failure(
        calls().describe({ ...asReader({ schemas: ["wide"] }), limits: { maxBytes: 1000 } })
      );

      expect(error).toMatchObject({ kind: "failed", message: "The query failed." });
    });
  });

  describe("columns of one name", () => {
    it("keeps every column of a join under a key of its own", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: `select o.id, o.customer, n.id, n.id + 1 as id
              from orders o join (values (41::bigint)) n (id) on o.id = 1`
      });

      expect(result.columns).toEqual([
        { name: "id", type: "bigint" },
        { name: "customer", type: "text" },
        { name: "id_2", type: "bigint" },
        { name: "id_3", type: "bigint" }
      ]);
      expect(result.rows).toEqual([{ id: "1", customer: "Ada Lovelace", id_2: "41", id_3: "42" }]);
    });

    it("keeps the values of columns that have no name", async () => {
      const result = await calls().query({ ...asReader(), sql: "select 1, 2, 'three'" });

      expect(result.columns.map((column) => column.name)).toEqual([
        "?column?",
        "?column?_2",
        "?column?_3"
      ]);
      expect(result.rows).toEqual([{ "?column?": 1, "?column?_2": 2, "?column?_3": "three" }]);
    });

    it("gives a suffixed key that is taken the next free number", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: "select 1 as id, 2 as id_2, 3 as id, 4 as id"
      });

      expect(result.rows).toEqual([{ id: 1, id_2: 2, id_3: 3, id_4: 4 }]);
    });

    it("returns a column named like a property every object has", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: `select 1 as "__proto__", 2 as "constructor", 3 as "toString"`
      });

      const [row] = result.rows;
      expect(Object.entries(required(row))).toEqual([
        ["__proto__", 1],
        ["constructor", 2],
        ["toString", 3]
      ]);
      expect(JSON.stringify(row)).toBe('{"__proto__":1,"constructor":2,"toString":3}');
    });
  });

  describe("what a query leaves on the session", () => {
    it("releases an advisory lock a query took for the session and keeps the connection", async () => {
      const held = () => customer.sql<{ pid: number }[]>`
        select pid from pg_locks where locktype = 'advisory' and objid = 4711
      `;

      const locked = await calls().query({
        ...asWriter(),
        sql: "select pg_advisory_lock(4711)::text as taken, pg_backend_pid() as pid"
      });

      expect(await held()).toEqual([]);
      const next = await calls().query({ ...asWriter(), sql: "select pg_backend_pid() as pid" });
      expect(next.rows).toEqual([{ pid: locked.rows[0]?.pid }]);
    });
  });

  describe("the database's own words", () => {
    it("hands a message that quotes a row to the caller of the query and prints none of it", async () => {
      const methods = ["log", "info", "warn", "error", "debug"] as const;
      const printed = methods.map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      );
      const written = [process.stdout, process.stderr].map((stream) => vi.spyOn(stream, "write"));
      try {
        const error = await failure(
          calls().query({
            ...asReader(),
            sql: `select (select lower(split_part(customer, ' ', 2)) from orders
                  where id = 1)::regclass`
          })
        );

        // The caller could have selected the value. The message goes to it and nowhere else.
        expect(error).toMatchObject({
          kind: "query_rejected",
          sqlState: "42P01",
          message: 'Query rejected: relation "lovelace" does not exist'
        });
        for (const method of printed) expect(method).not.toHaveBeenCalled();
        const output = written.flatMap((write) => write.mock.calls.map(([chunk]) => String(chunk)));
        expect(output.join("")).not.toMatch(/lovelace/iu);
      } finally {
        for (const spy of [...printed, ...written]) spy.mockRestore();
      }
    });
  });

  describe("settings of the process", () => {
    it("keeps its own connect timeout when the process names another", async () => {
      // A second is less than the credential takes. The driver would give up on the connection.
      vi.stubEnv("PGCONNECT_TIMEOUT", "1");
      vi.stubEnv("PGIDLE_TIMEOUT", "1");
      vi.stubEnv("PGMAX_LIFETIME", "1");
      slowCredentialMs = 1500;

      const result = await newExecutor().query({ ...asWriter(), sql: "select 1 as one" });

      expect(result.rows).toEqual([{ one: 1 }]);
    });

    it("refuses to work when the process tells the driver which servers to accept", async () => {
      vi.stubEnv("PGTARGETSESSIONATTRS", "read-only");
      const before = addressChecks;
      const started = performance.now();

      const error = await failure(newExecutor().ping(asReader()));

      expect(error).toMatchObject({ kind: "failed" });
      expect(addressChecks).toBe(before);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("an address check that never answers", () => {
    it("does not hold up the end of a call that is cancelled", async () => {
      const executor = newExecutor();
      const abort = new AbortController();
      const call = failure(
        executor.query({
          ...asWriter(),
          signal: abort.signal,
          limits: { statementTimeoutMs: 3000 },
          sql: "select pg_sleep(30) /* no way to cancel */"
        })
      );
      await customer.runningQuery(writer, "no way to cancel");
      // The socket of the cancel request is the next one to be checked.
      addressCheckHangsFrom = addressChecks + 1;
      const started = performance.now();

      abort.abort();

      expect(await call).toMatchObject({ kind: "cancelled" });
      // The wait for the cancel request is the grace of one second, and then the call ends.
      expect(performance.now() - started).toBeLessThan(2500);
    });

    it("ends a call at its deadline", async () => {
      addressCheckHangsFrom = 0;
      const started = performance.now();

      const error = await failure(
        newExecutor().ping({ ...asReader(), limits: { statementTimeoutMs: 200 } })
      );

      expect(error).toMatchObject({ kind: "timeout" });
      expect(performance.now() - started).toBeLessThan(2500);
    });
  });
});
