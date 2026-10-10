import { createServer } from "node:net";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

const MADE_UP_PASSWORD = "made-up-password-7c1f";

/** What can be on its way between the server and a socket that has just been closed. */
const SLACK = 8_000_000;

describe("Postgres executor guards", () => {
  const customer = useCustomerDatabase();
  const { reader, writer, host } = customer;
  let slowCredentialMs = 0;
  /** From which socket on the address check never answers. */
  let addressCheckHangsFrom = Number.POSITIVE_INFINITY;
  let addressChecks = 0;
  /** Runs while the address check is asked, which is when a caller could change its object. */
  let duringAddressCheck: (() => void) | undefined;
  let secretsBeingResolved = 0;
  const unheard: unknown[] = [];
  const hear = (error: unknown) => unheard.push(error);
  let relay: PostgresRelay | undefined;
  const executors: PostgresExecutor[] = [];

  function newExecutor(): PostgresExecutor {
    const executor = createPostgresExecutor({
      secrets: {
        async getSecret(name) {
          secretsBeingResolved += 1;
          await delay(slowCredentialMs);
          secretsBeingResolved -= 1;
          return (
            customer.passwords.get(name) ?? (name === "made-up" ? MADE_UP_PASSWORD : undefined)
          );
        }
      },
      pinAddress() {
        addressChecks += 1;
        duringAddressCheck?.();
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
    process.on("uncaughtException", hear);
    process.on("unhandledRejection", hear);
    relay = await startPostgresRelay({ host: customer.address, port: customer.port });
    newExecutor();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    slowCredentialMs = 0;
    addressCheckHangsFrom = Number.POSITIVE_INFINITY;
    duringAddressCheck = undefined;
  });

  afterAll(async () => {
    await Promise.all(executors.map((executor) => executor.close()));
    await relay?.close();
    process.off("uncaughtException", hear);
    process.off("unhandledRejection", hear);
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
      const cancelsBefore = required(relay).cancelRequests();

      const result = await calls().query({
        ...throughRelay,
        limits: { maxBytes: 1000 },
        sql: "select repeat('x', 150000000) as large"
      });

      expect(result).toMatchObject({ rows: [], truncatedBy: "bytes" });
      expect(required(relay).bytesFromServer() - before).toBeLessThan(
        POSTGRES_READ_MARGIN_BYTES + SLACK
      );
      // The socket is closed by the executor, which tells the server nothing. The cancel does.
      expect(required(relay).cancelRequests() - cancelsBefore).toBe(1);
      await expect.poll(() => customer.backends(reader), { timeout: 3000 }).toEqual([]);
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

  describe("a credential that resolves after the call has ended", () => {
    const ROUNDS = 3;

    async function expectNothingThrownAndEverySlotFree(executor: PostgresExecutor): Promise<void> {
      await expect.poll(() => secretsBeingResolved, { timeout: 5000 }).toBe(0);
      // An authentication that went on would fail in the turns after the secret arrived.
      for (let turn = 0; turn < 20; turn += 1) await nextTurn();
      expect(unheard).toEqual([]);
      slowCredentialMs = 0;
      const next = await Promise.all([0, 1, 2, 3].map(() => executor.ping(asWriter())));
      expect(next).toHaveLength(4);
      expect(unheard).toEqual([]);
      // The account may hold seven connections, and other tests need theirs.
      await executor.close();
    }

    it("stops authenticating at the deadline, time after time", async () => {
      const executor = newExecutor();
      const errors = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        slowCredentialMs = 1800;
        errors.push(
          ...(await Promise.all(
            [0, 1, 2, 3].map(() =>
              failure(executor.ping({ ...asWriter(), limits: { statementTimeoutMs: 100 } }))
            )
          ))
        );
      }

      expect(errors.map((error) => error.kind)).toEqual(
        Array.from({ length: ROUNDS * 4 }, () => "timeout")
      );
      await expectNothingThrownAndEverySlotFree(executor);
    });

    it("stops authenticating when the caller aborts, time after time", async () => {
      const executor = newExecutor();
      const errors = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        slowCredentialMs = 600;
        const abort = new AbortController();
        const round4 = [0, 1, 2, 3].map(() =>
          failure(executor.ping({ ...asWriter(), signal: abort.signal }))
        );
        await expect.poll(() => secretsBeingResolved, { timeout: 5000 }).toBe(4);
        abort.abort();
        errors.push(...(await Promise.all(round4)));
        await expect.poll(() => secretsBeingResolved, { timeout: 5000 }).toBe(0);
      }

      expect(errors.map((error) => error.kind)).toEqual(
        Array.from({ length: ROUNDS * 4 }, () => "cancelled")
      );
      await expectNothingThrownAndEverySlotFree(executor);
    });
  });

  describe("a caller that changes its target while the call runs", () => {
    it("dials what the address check was asked about", async () => {
      const target = asReader();
      const location = { ...target.location, schemas: [...target.location.schemas] };
      duringAddressCheck = () => {
        location.port = 1;
        location.tls = "verify-full";
        location.database = "another_database";
        location.user = writer;
        location.schemas.splice(0, 1, "public");
      };

      const result = await newExecutor().query({
        ...target,
        location,
        sql: "select current_user::text as account, count(*)::integer as orders from orders"
      });

      expect(location.port).toBe(1);
      expect(result.rows).toEqual([{ account: reader, orders: 2 }]);
    });

    it("keeps to verified TLS when the caller's object turns it off meanwhile", async () => {
      const location = { ...asReader().location, tls: "verify-full" as "verify-full" | "off" };
      duringAddressCheck = () => {
        location.tls = "off";
      };

      const error = await failure(newExecutor().ping({ ...asReader(), location }));

      expect(error.kind).toBe("tls_failed");
    });
  });

  describe("JSON values", () => {
    it("keeps keys named like a property every object has, at any depth", async () => {
      const result = await calls().query({
        ...asReader(),
        sql: `select '{"__proto__": {"admin": true}, "constructor": 2,
                       "deep": [{"__proto__": 3}]}'::jsonb as doc,
                     '{"__proto__": 1}'::json as plain`
      });

      const [row] = result.rows;
      expect(JSON.stringify(row)).toBe(
        '{"doc":{"deep":[{"__proto__":3}],"__proto__":{"admin":true},"constructor":2},' +
          '"plain":{"__proto__":1}}'
      );
      expect(Object.getPrototypeOf(row?.doc)).toBe(Object.prototype);
      expect(row?.doc).not.toHaveProperty("admin");
    });
  });

  describe("an endpoint that answers a login with a message of its own", () => {
    it("passes on no text of an error raised before the session is authenticated", async () => {
      // Asks for the password in clear and sends it back as a syntax error.
      const hostile = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.once("data", () => {
          socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]));
          socket.once("data", (answer: Buffer) => {
            const password = answer.subarray(5, answer.length - 1).toString();
            const fields = Buffer.from(
              `SERROR\0VERROR\0C42601\0Msyntax error at or near "${password}"\0\0`
            );
            const head = Buffer.alloc(5);
            head.write("E");
            head.writeUInt32BE(fields.length + 4, 1);
            socket.end(Buffer.concat([head, fields]));
          });
        });
      });
      await new Promise<void>((resolve) => hostile.listen(0, customer.address, resolve));
      const { port } = z.object({ port: z.number() }).parse(hostile.address());
      try {
        const error = await failure(newExecutor().ping(on(reader, "made-up", { port })));

        expect(error).toMatchObject({
          kind: "failed",
          sqlState: "42601",
          message: "The query failed."
        });
        expect(
          [
            error.stack,
            JSON.stringify(error),
            inspect(error, { depth: 6, showHidden: true })
          ].join()
        ).not.toContain(MADE_UP_PASSWORD);
      } finally {
        hostile.close();
      }
    });
  });
});
