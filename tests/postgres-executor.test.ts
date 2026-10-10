import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createPostgresExecutor,
  planPostgresSocket,
  POSTGRES_PARAMETERS_MAX_COUNT,
  POSTGRES_POOL_ACQUIRE_WAIT_MS,
  POSTGRES_POOL_MAX_CONNECTIONS,
  POSTGRES_QUERY_TEXT_MAX_CHARS,
  POSTGRES_RESULT_MAX_BYTES,
  POSTGRES_RESULT_MAX_ROWS,
  PostgresExecutorError,
  type PostgresExecutor,
  type PostgresLocation,
  type PostgresTarget
} from "@vivd-catalyst/postgres-connector";
import { deferred, required } from "./support/assertions";
import { executorFailure as failure, useCustomerDatabase } from "./support/customer-database";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";

describe("Postgres executor on a customer's database", () => {
  const customer = useCustomerDatabase();
  const { reader, writer, host } = customer;
  const passwords = new Map(customer.passwords);
  passwords.set("slow-writer-password", required(passwords.get("writer-password")));
  passwords.set("wrong-password", `wrong-${randomUUID()}`);
  let slowCredentialMs = 0;
  const pinned: [string, number][] = [];
  const resolved: string[] = [];
  let executor: PostgresExecutor | undefined;

  const sql = () => customer.sql;
  const calls = () => required(executor);
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

  beforeAll(() => {
    executor = createPostgresExecutor({
      secrets: {
        async getSecret(name) {
          resolved.push(name);
          if (name.startsWith("slow-")) await delay(slowCredentialMs);
          return passwords.get(name);
        }
      },
      async pinAddress(name, port) {
        pinned.push([name, port]);
        if (name === "blocked.customer.example") return { allowed: false };
        // A name as the answer must be refused: the socket would resolve it again.
        const answer = name === "named.customer.example" ? "localhost" : customer.address;
        return { allowed: true, address: answer };
      }
    });
  });

  afterAll(() => executor?.close());

  describe("results", () => {
    it("returns typed columns and values in their JSON forms", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: `select id, amount, placed_on, placed_at, tags, 9007199254740993::bigint as big,
                null::text as nothing, true as flag, 1.5::float8 as ratio,
                'NaN'::float8 as unknown_ratio, '{"a": [1]}'::jsonb as doc,
                '2024-05-01 10:00:00'::timestamp as local_time, '\\x00ff'::bytea as raw
              from orders order by id`
      });

      expect(result.columns.map(({ name, type }) => `${name} ${type}`).join(", ")).toBe(
        "id bigint, amount numeric, placed_on date, placed_at timestamp with time zone, " +
          "tags text[], big bigint, nothing text, flag boolean, ratio double precision, " +
          "unknown_ratio double precision, doc jsonb, " +
          "local_time timestamp without time zone, raw bytea"
      );
      expect(result.rows).toEqual([
        {
          id: "1",
          amount: "19.90",
          placed_on: "2024-05-01",
          placed_at: "2024-05-01T10:00:00Z",
          tags: ["new", 'b"c'],
          big: "9007199254740993",
          nothing: null,
          flag: true,
          ratio: 1.5,
          unknown_ratio: "NaN",
          doc: { a: [1] },
          local_time: "2024-05-01T10:00:00",
          raw: "\\x00ff"
        },
        expect.objectContaining({ id: "2", placed_at: "2024-05-02T10:30:00.5Z", tags: [] })
      ]);
      expect(result).toMatchObject({ rowCount: 2, truncated: false });
      expect(result).not.toHaveProperty("truncatedBy");
    });

    it("returns the columns of a query that finds no row", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: "select id, customer from orders where false"
      });

      expect(result).toEqual({
        columns: [
          { name: "id", type: "bigint" },
          { name: "customer", type: "text" }
        ],
        rows: [],
        rowCount: 0,
        truncated: false
      });
    });

    it("stops at the row cap without reading the rest", async () => {
      // A hundred million rows of a hundred bytes: only a cursor that stops answers in time.
      const result = await calls().query({
        ...asReader(),
        sql: "select generate_series(1, 100000000) as n, repeat('x', 100) as pad"
      });

      expect(result.rows).toHaveLength(POSTGRES_RESULT_MAX_ROWS);
      expect(result).toMatchObject({
        rowCount: POSTGRES_RESULT_MAX_ROWS,
        truncated: true,
        truncatedBy: "rows"
      });
      expect(result.rows.at(-1)).toMatchObject({ n: POSTGRES_RESULT_MAX_ROWS });
    });

    it("stops a wide result at the byte cap", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: "select repeat('x', 100000) as pad from generate_series(1, 1000)"
      });

      expect(result).toMatchObject({ truncated: true, truncatedBy: "bytes" });
      expect(result.rowCount).toBe(20);
      expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThan(
        POSTGRES_RESULT_MAX_BYTES
      );
    });

    it("lets a caller lower a cap and never raise one", async () => {
      const series = "select generate_series(1, 2000) as n";

      const lowered = await calls().query({ ...asReader(), limits: { maxRows: 5 }, sql: series });
      const raised = await calls().query({
        ...asReader(),
        limits: { maxRows: 5000, maxBytes: 2 ** 40 },
        sql: series
      });
      const exact = await calls().query({
        ...asReader(),
        limits: { maxRows: 2 },
        sql: "select id from orders"
      });

      expect(lowered).toMatchObject({ rowCount: 5, truncatedBy: "rows" });
      expect(raised).toMatchObject({ rowCount: POSTGRES_RESULT_MAX_ROWS, truncatedBy: "rows" });
      expect(exact).toMatchObject({ rowCount: 2, truncated: false });
    });
  });

  describe("parameters", () => {
    it("binds a value that tries to end the statement", async () => {
      const attack = "'; drop table reporting.orders; --";

      const result = await calls().query({
        ...asReader(),
        sql: "select id from orders where customer = $1 or customer = $2",
        parameters: [attack, { type: "text", value: attack }]
      });

      expect(result.rows).toEqual([]);
      expect(await sql()`select count(*)::int as orders from reporting.orders`).toEqual([
        { orders: 2 }
      ]);
    });

    it("leaves the type of a bare value to the place it stands in", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: `select customer from orders
              where id = $1 and amount > $2 and placed_on = $3 and $4 and id = any($5)
                and tags && $6 and $7::text is null`,
        parameters: [1, 0.5, "2024-05-01", true, [1, 2, null], ['b"c', "x,y"], null]
      });

      expect(result.rows).toEqual([{ customer: "Ada Lovelace" }]);
    });

    it("sends a declared type as that type", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: `select $1 as t, $2 as i, $3 as n, $4 as b, $5 as d, $6 as ts, $7 as ids, $8 as days,
                pg_typeof($2)::text as i_type, pg_typeof($7)::text as ids_type`,
        parameters: [
          { type: "text", value: "plain" },
          { type: "integer", value: "9007199254740993" },
          { type: "number", value: 1.25 },
          { type: "boolean", value: false },
          { type: "date", value: "2024-02-29" },
          { type: "timestamp", value: "2024-02-29T08:15:00+01:00" },
          { type: "integer[]", value: [1, null, 3] },
          { type: "date[]", value: [] }
        ]
      });

      expect(result.rows).toEqual([
        {
          t: "plain",
          i: "9007199254740993",
          n: "1.25",
          b: false,
          d: "2024-02-29",
          ts: "2024-02-29T07:15:00Z",
          ids: ["1", null, "3"],
          days: [],
          i_type: "bigint",
          ids_type: "bigint[]"
        }
      ]);
    });

    it.each([
      ["a word as an integer", { type: "integer", value: "customer-secret-17" }],
      ["a fraction as an integer", { type: "integer", value: 1.5 }],
      ["a list as a scalar", { type: "text", value: ["customer-secret-17"] }],
      ["a scalar as a list", { type: "text[]", value: "customer-secret-17" }],
      ["a date that is none", { type: "date", value: "customer-secret-17" }],
      ["a list of mixed kinds", ["customer-secret-17", 1]],
      ["a number that is none", Number.NaN]
    ] as const)("refuses %s without repeating it", async (_case, parameter) => {
      const error = await failure(
        calls().query({ ...asReader(), sql: "select $1 as value", parameters: [parameter] })
      );

      expect(error).toMatchObject({
        kind: "query_rejected",
        message: "Parameter 1 does not match its type"
      });
      expect(everythingOn(error)).not.toContain("customer-secret-17");
    });

    it("refuses more parameters and more text than a query may have", async () => {
      const tooMany = await failure(
        calls().query({
          ...asReader(),
          sql: "select 1",
          parameters: Array.from({ length: POSTGRES_PARAMETERS_MAX_COUNT + 1 }, () => 1)
        })
      );
      const tooLong = await failure(
        calls().query({
          ...asReader(),
          sql: `select '${"x".repeat(POSTGRES_QUERY_TEXT_MAX_CHARS)}'`
        })
      );

      expect(tooMany).toMatchObject({ kind: "query_rejected" });
      expect(tooLong).toMatchObject({ kind: "query_rejected" });
    });
  });

  describe("read-only transaction", () => {
    it("refuses a write that the keyword screen cannot see, on an account that may write", async () => {
      const error = await failure(
        calls().query({ ...asWriter(), sql: "select reporting.record_visit() as id" })
      );

      expect(error).toMatchObject({
        kind: "read_only_violation",
        sqlState: "25006",
        message: "The query tried to change data. Queries run in a read-only transaction."
      });
      expect(await sql()`select count(*)::int as visits from reporting.visits`).toEqual([
        { visits: 0 }
      ]);
    });

    it.each([
      ["a write", "insert into reporting.visits (note) values ('x')"],
      ["a write inside a read", "with w as (insert into visits (note) values ('x')) select 1"],
      ["two statements", "select 1; select 2"],
      ["a second statement after a comment", "select 1 /* ; */; delete from visits"],
      ["a session setting", "set statement_timeout = 0"],
      ["a row lock", "select id from orders for update"]
    ])("refuses %s before the database is asked", async (_case, statement) => {
      const before = pinned.length;

      const error = await failure(calls().query({ ...asWriter(), sql: statement }));

      expect(error.kind).toBe("query_rejected");
      expect(pinned).toHaveLength(before);
      expect(await sql()`select count(*)::int as visits from reporting.visits`).toEqual([
        { visits: 0 }
      ]);
    });

    it("keeps nothing a query set on the session for the next query", async () => {
      const first = await calls().query({
        ...asReader(),
        sql: `select set_config('search_path', 'pg_catalog', false) as path,
                set_config('catalyst.marker', 'left behind', false) as marker,
                pg_backend_pid() as pid`
      });
      const second = await calls().query({
        ...asReader(),
        sql: `select count(*)::int as orders, current_setting('catalyst.marker', true) as marker,
                pg_backend_pid() as pid
              from orders`
      });

      expect(first.rows).toMatchObject([{ path: "pg_catalog", marker: "left behind" }]);
      expect(second.rows[0]?.pid).toBe(first.rows[0]?.pid);
      expect(second.rows).toMatchObject([{ orders: 2 }]);
      expect(["", null]).toContain(second.rows[0]?.marker);
    });
  });

  describe("deadline", () => {
    it("ends a slow statement by the timeout set in the transaction", async () => {
      const [before] = (
        await calls().query({ ...asReader(), sql: "select pg_backend_pid() as pid" })
      ).rows;
      const started = performance.now();

      const error = await failure(
        calls().query({
          ...asReader(),
          limits: { statementTimeoutMs: 200 },
          sql: "select pg_sleep(30)"
        })
      );

      expect(error).toMatchObject({
        kind: "timeout",
        sqlState: "57014",
        message: "The query ran longer than the time limit and was cancelled."
      });
      // The database ended it, well before the platform's own timer at 1200 ms.
      expect(performance.now() - started).toBeLessThan(1000);
      const after = await calls().query({ ...asReader(), sql: "select pg_backend_pid() as pid" });
      expect(after.rows).toEqual([before]);
    });

    it("still ends a query that sets its timeout to zero before it sleeps", async () => {
      const started = performance.now();

      const error = await failure(
        calls().query({
          ...asReader(),
          limits: { statementTimeoutMs: 300 },
          sql: "select set_config('statement_timeout', '0', true), pg_sleep(30)"
        })
      );

      // One guard or the other: the database keeps the timeout its statement started under,
      // and the platform's timer would follow a second later.
      expect(error.kind).toBe("timeout");
      expect(performance.now() - started).toBeLessThan(3000);
      expect(await calls().query({ ...asReader(), sql: "select 1 as one" })).toMatchObject({
        rows: [{ one: 1 }]
      });
    });

    it("cancels on the server a query the database's timeout has not reached at the deadline", async () => {
      // The credential takes 3.5 of the 5 seconds the call has. The statement then starts with
      // its 4 seconds on the server, so at the deadline only the platform's timer can end it.
      slowCredentialMs = 3500;
      const started = performance.now();
      const call = failure(
        calls().query({
          ...on(writer, "slow-writer-password"),
          limits: { statementTimeoutMs: 4000 },
          sql: "select pg_sleep(30) /* past the deadline */"
        })
      );
      const pid = await customer.runningQuery(writer, "past the deadline");

      const error = await call;

      expect(error).toMatchObject({ kind: "timeout" });
      // The database's own cancellation would have come with its SQLSTATE.
      expect(error.sqlState).toBeUndefined();
      expect(performance.now() - started).toBeGreaterThanOrEqual(5000);
      // Left alone, the backend would sleep until the database's timeout at 7.5 seconds.
      await expect.poll(() => customer.ended(writer, pid), { timeout: 1500 }).toBe(true);
      expect(performance.now() - started).toBeLessThan(7000);
    });

    it("gives up on a server that never answers and drops the socket", async () => {
      const closed = deferred<undefined>();
      const silent = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.on("close", () => closed.resolve(undefined));
        socket.resume();
      });
      await new Promise<void>((resolve) => silent.listen(0, customer.address, resolve));
      const { port } = z.object({ port: z.number() }).parse(silent.address());
      try {
        const started = performance.now();

        const error = await failure(
          calls().ping({ ...asReader({ port }), limits: { statementTimeoutMs: 300 } })
        );

        expect(error).toMatchObject({ kind: "timeout" });
        expect(performance.now() - started).toBeGreaterThanOrEqual(1300);
        await closed.promise;
      } finally {
        silent.close();
      }
    });

    it("cancels on the server when the caller aborts", async () => {
      const abort = new AbortController();
      const call = failure(
        calls().query({
          ...asWriter(),
          signal: abort.signal,
          sql: "select pg_sleep(30) /* aborted */"
        })
      );
      const pid = await customer.runningQuery(writer, "aborted");

      abort.abort();

      expect(await call).toMatchObject({ kind: "cancelled", message: "The query was cancelled." });
      await expect.poll(() => customer.ended(writer, pid), { timeout: 5000 }).toBe(true);
    });

    it("does not start a call whose caller has already aborted", async () => {
      const before = pinned.length;

      const error = await failure(
        calls().query({ ...asReader(), signal: AbortSignal.abort(), sql: "select 1" })
      );

      expect(error.kind).toBe("cancelled");
      expect(pinned).toHaveLength(before);
    });
  });

  describe("pool", () => {
    it("holds four connections under fifty calls and fails the rest as busy after the wait", async () => {
      let watching = true;
      let mostBackends = 0;
      const watch = (async () => {
        while (watching) {
          mostBackends = Math.max(mostBackends, (await customer.backends(reader)).length);
          await delay(100);
        }
      })();
      const started = performance.now();

      const outcomes = await Promise.all(
        Array.from({ length: 50 }, async () => {
          try {
            await calls().query({ ...asReader(), sql: "select pg_sleep(6)" });
            return { kind: "answered", afterMs: performance.now() - started };
          } catch (error) {
            const { kind } = required(error instanceof PostgresExecutorError ? error : undefined);
            return { kind, afterMs: performance.now() - started };
          }
        })
      );
      watching = false;
      await watch;

      const busy = outcomes.filter((outcome) => outcome.kind === "busy");
      expect(outcomes.filter((outcome) => outcome.kind === "answered")).toHaveLength(
        POSTGRES_POOL_MAX_CONNECTIONS
      );
      expect(busy).toHaveLength(50 - POSTGRES_POOL_MAX_CONNECTIONS);
      for (const outcome of busy) {
        expect(outcome.afterMs).toBeGreaterThanOrEqual(POSTGRES_POOL_ACQUIRE_WAIT_MS - 50);
        expect(outcome.afterMs).toBeLessThan(POSTGRES_POOL_ACQUIRE_WAIT_MS + 900);
      }
      expect(mostBackends).toBe(POSTGRES_POOL_MAX_CONNECTIONS);
    });

    it("hands a freed connection to a call that waits", async () => {
      const limits = { maxConnections: 1 };
      const slow = calls().query({ ...asReader(), limits, sql: "select pg_sleep(0.5), 1 as one" });
      const waiting = calls().query({
        ...asReader(),
        limits,
        sql: "select pg_backend_pid() as pid"
      });

      expect((await slow).rows).toMatchObject([{ one: 1 }]);
      expect((await waiting).rowCount).toBe(1);
    });
  });

  describe("reaching the database", () => {
    it("asks the address check with the configured name and dials what it answers", async () => {
      pinned.length = 0;
      const fresh = on(reader, "reader-password", { schemas: [] });

      await calls().ping({ ...fresh, location: { ...fresh.location, database: "postgres" } });

      // The name does not resolve anywhere, so only the pinned address can have answered.
      expect(pinned).toEqual([[host, customer.port]]);
    });

    it("refuses a target the address check denies, before the password is resolved", async () => {
      resolved.length = 0;

      const denied = await failure(
        calls().ping(asReader({ host: "blocked.customer.example", database: "postgres" }))
      );
      const named = await failure(
        calls().ping(asReader({ host: "named.customer.example", database: "postgres" }))
      );

      expect(denied).toMatchObject({
        kind: "network_denied",
        message: "The address of this database is not an allowed destination."
      });
      // A name as the answer would be resolved again by the socket, past the check.
      expect(named.kind).toBe("network_denied");
      expect(resolved).toEqual([]);
    });

    it("fails as tls_failed against a server without TLS, before the password is resolved", async () => {
      resolved.length = 0;

      const error = await failure(
        calls().ping(asReader({ tls: "verify-full", database: "postgres" }))
      );

      expect(error).toMatchObject({
        kind: "tls_failed",
        message: "A verified TLS connection to the database could not be established."
      });
      expect(resolved).toEqual([]);
    });

    it("dials the pinned address, names the host to TLS and verifies the certificate", () => {
      const place = asReader({ tls: "verify-full" }).location;

      expect(planPostgresSocket(place, "203.0.113.7")).toEqual({
        socket: { host: "203.0.113.7", port: place.port },
        tls: { host, servername: host, rejectUnauthorized: true }
      });
      expect(
        planPostgresSocket({ ...place, host: "198.51.100.4", caBundle: "PEM" }, "198.51.100.4").tls
      ).toEqual({ host: "198.51.100.4", rejectUnauthorized: true, ca: "PEM" });
      expect(planPostgresSocket({ ...place, tls: "off" }, "203.0.113.7")).toEqual({
        socket: { host: "203.0.113.7", port: place.port }
      });
    });

    it.each([
      ["a wrong password", "wrong-password"],
      ["a credential that does not resolve", "missing-password"]
    ])("answers %s as unauthorized and names no host, user or secret", async (_case, handle) => {
      const error = await failure(calls().ping(on(reader, handle)));

      expect(error).toMatchObject({
        kind: "unauthorized",
        message: "The credential of this connection is missing or the database refused it."
      });
      expectNothingOfTheTarget(error);
    });

    it("answers a database that is not there as unavailable and names no address", async () => {
      const error = await failure(calls().ping(asReader({ port: 1 })));

      expect(error).toMatchObject({
        kind: "unavailable",
        message: "The database could not be reached."
      });
      expectNothingOfTheTarget(error);
    });

    it("works again once the credential is right", async () => {
      await failure(calls().ping(on(reader, "wrong-password")));

      await expect(calls().ping(asReader())).resolves.toBeUndefined();
    });
  });

  describe("errors", () => {
    it("tells the author which column the query got wrong", async () => {
      const error = await failure(
        calls().query({ ...asReader(), sql: "select missing_column from orders" })
      );

      expect(error).toMatchObject({
        kind: "query_rejected",
        sqlState: "42703",
        message:
          'Query rejected: column "missing_column" does not exist (at character 8 of the query)'
      });
    });

    it("names the relation an account may not read", async () => {
      await sql()`revoke select on reporting.order_lines from ${sql()(reader)}`;
      try {
        const error = await failure(
          calls().query({ ...asReader(), sql: "select id from order_lines" })
        );

        expect(error).toMatchObject({
          kind: "query_rejected",
          sqlState: "42501",
          message: "Query rejected: permission denied for table order_lines"
        });
      } finally {
        await sql()`grant select on reporting.order_lines to ${sql()(reader)}`;
      }
    });

    it.each([
      ["a row value", "select customer::integer from orders", []],
      ["a parameter", "select cast($1 as integer)", ["customer-secret-17"]],
      ["a division by zero", "select 1 / (id - id) from orders", []]
    ])("keeps the database's words about %s to itself", async (_case, statement, parameters) => {
      const error = await failure(calls().query({ ...asReader(), sql: statement, parameters }));

      expect(error).toMatchObject({ kind: "failed", message: "The query failed." });
      expect(error.sqlState).toMatch(/^22/u);
      const text = everythingOn(error);
      for (const leaked of ["Ada Lovelace", "customer-secret-17", "invalid input", statement]) {
        expect(text).not.toContain(leaked);
      }
    });

    it("prints nothing, whatever the database says", async () => {
      const methods = ["log", "info", "warn", "error", "debug"] as const;
      const printed = methods.map((method) =>
        vi.spyOn(console, method).mockImplementation(() => undefined)
      );
      try {
        const noisy = await calls().query({ ...asReader(), sql: "select reporting.noisy() as n" });
        await failure(calls().ping(on(reader, "wrong-password")));
        await failure(
          calls().query({ ...asReader(), sql: "select customer::integer from orders" })
        );

        expect(noisy.rows).toEqual([{ n: 1 }]);
        for (const method of printed) expect(method).not.toHaveBeenCalled();
      } finally {
        for (const method of printed) method.mockRestore();
      }
    });
  });

  describe("describe", () => {
    it("lists the relations the account can read in the configured schemas", async () => {
      const described = await calls().describe(asReader());

      expect(described).toEqual({
        relations: [
          { schema: "reporting", name: "order_lines", type: "table" },
          { schema: "reporting", name: "orders", type: "table", description: "Orders of the shop" },
          { schema: "reporting", name: "visits", type: "table" }
        ],
        truncated: false
      });
      expect(await calls().describe(asReader({ schemas: ["public"] }))).toEqual({
        relations: [],
        truncated: false
      });
      expect(await calls().describe({ ...asReader(), limits: { maxRows: 2 } })).toMatchObject({
        relations: [{ name: "order_lines" }, { name: "orders" }],
        truncated: true
      });
    });

    it("describes the columns and keys of one relation", async () => {
      const lines = await calls().describe({ ...asReader(), relation: "reporting.order_lines" });
      const orders = await calls().describe({ ...asReader({ schemas: [] }), relation: "orders" });

      expect(lines.relation).toEqual({
        schema: "reporting",
        name: "order_lines",
        type: "table",
        columns: [
          { name: "id", dataType: "bigint", nullable: false },
          { name: "order_id", dataType: "bigint", nullable: false },
          { name: "sku", dataType: "text", nullable: false }
        ],
        primaryKey: ["id"],
        foreignKeys: [
          {
            columns: ["order_id"],
            referencedSchema: "reporting",
            referencedRelation: "orders",
            referencedColumns: ["id"]
          }
        ]
      });
      expect(orders.relation?.columns).toContainEqual({
        name: "customer",
        dataType: "text",
        nullable: false,
        description: "Who ordered"
      });
    });

    it("says when a relation is not one the account can read", async () => {
      const missing = await failure(calls().describe({ ...asReader(), relation: "invoices" }));
      const malformed = await failure(calls().describe({ ...asReader(), relation: "a.b.c" }));

      expect(missing).toMatchObject({
        kind: "query_rejected",
        message: "Readable relation 'invoices' was not found"
      });
      expect(malformed.kind).toBe("query_rejected");
    });
  });

  describe("privileges", () => {
    it("reads an account that can only read", async () => {
      const privileges = await calls().readPrivileges(asReader());

      expect(privileges).toEqual({
        checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u),
        account: { user: reader, superuser: false },
        canChangeData: false,
        writableObjects: [],
        readableRelations: [
          { schema: "reporting", name: "order_lines" },
          { schema: "reporting", name: "orders" },
          { schema: "reporting", name: "visits" }
        ],
        listTruncated: false
      });
    });

    it("names what an account can change, and the role's own limits", async () => {
      const privileges = await calls().readPrivileges(asWriter());

      expect(privileges).toMatchObject({
        account: { user: writer, superuser: false, connectionLimit: 7, statementTimeoutMs: 45000 },
        canChangeData: true,
        writableObjects: [
          { kind: "relation", schema: "reporting", name: "visits", privileges: ["insert"] }
        ],
        listTruncated: false
      });
    });
  });

  /** What a log line or an error page could show of this error, hidden properties included. */
  function everythingOn(error: PostgresExecutorError): string {
    return [
      error.message,
      error.stack,
      JSON.stringify(error),
      inspect(error, { depth: 6, showHidden: true })
    ].join("\n");
  }

  function expectNothingOfTheTarget(error: PostgresExecutorError): void {
    const text = everythingOn(error);
    const secrets = [...passwords.values()];
    for (const leaked of [host, customer.address, reader, customer.database, ...secrets]) {
      expect(text).not.toContain(leaked);
    }
    expect(error).not.toHaveProperty("cause");
  }
});
