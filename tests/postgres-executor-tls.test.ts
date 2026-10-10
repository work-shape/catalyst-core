import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  createPostgresExecutor,
  type PostgresExecutor,
  type PostgresLocation,
  type PostgresTarget
} from "@vivd-catalyst/postgres-connector";
import { required } from "./support/assertions";
import { executorFailure as failure, useCustomerDatabase } from "./support/customer-database";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { startPostgresRelay, type PostgresRelay } from "./support/postgres-relay";
import { makeTestCertificate } from "./support/test-certificate";

/** How often each way of ending a call early is run. A crash showed in four of five. */
const CANCELS = 12;

describe("Postgres executor over verified TLS", () => {
  const customer = useCustomerDatabase();
  const { writer, host } = customer;
  const certificate = makeTestCertificate(host);
  const resolved: string[] = [];
  const unheard: unknown[] = [];
  const hear = (error: unknown) => unheard.push(error);
  let slowCredentialMs = 0;
  let relay: PostgresRelay | undefined;
  let executor: PostgresExecutor | undefined;

  const calls = () => required(executor);
  const overTls = (place: Partial<PostgresLocation> = {}): PostgresTarget => ({
    location: {
      host,
      port: required(relay).port,
      database: customer.database,
      user: writer,
      tls: "verify-full",
      caBundle: certificate.authority,
      schemas: ["reporting"],
      ...place
    },
    credentialHandle: "writer-password"
  });

  beforeAll(async () => {
    // An error or a rejection nobody handles would end a process that serves other calls.
    process.on("uncaughtException", hear);
    process.on("unhandledRejection", hear);
    relay = await startPostgresRelay({ host: customer.address, port: customer.port }, certificate);
    executor = createPostgresExecutor({
      secrets: {
        async getSecret(name) {
          resolved.push(name);
          await delay(slowCredentialMs);
          return customer.passwords.get(name);
        }
      },
      pinAddress: () => Promise.resolve({ allowed: true, address: "127.0.0.1" })
    });
  });

  afterAll(async () => {
    await executor?.close();
    await relay?.close();
    process.off("uncaughtException", hear);
    process.off("unhandledRejection", hear);
  });

  /** Every backend of the account is gone, and nothing was thrown past the calls meanwhile. */
  async function expectNothingLeft(): Promise<void> {
    await expect.poll(() => customer.backends(writer), { timeout: 8000 }).toEqual([]);
    // A late write on a socket that was taken away fails after its call has returned.
    await delay(300);
    expect(unheard).toEqual([]);
  }

  it("reads through a connection whose certificate the given authority signed", async () => {
    const result = await calls().query({
      ...overTls(),
      sql: "select customer from orders where id = $1",
      parameters: [1]
    });

    expect(result.rows).toEqual([{ customer: "Ada Lovelace" }]);
    expect(required(relay).securedConnections()).toBe(1);
  });

  it("refuses a certificate of an unknown authority or for another name, before the password", async () => {
    const before = resolved.length;
    const { caBundle: _systemRoots, ...unknownAuthority } = overTls().location;

    const errors = [
      await failure(calls().ping({ ...overTls(), location: unknownAuthority })),
      await failure(calls().ping(overTls({ host: "other.customer.example" })))
    ];

    expect(errors.map((error) => error.kind)).toEqual(["tls_failed", "tls_failed"]);
    expect(resolved).toHaveLength(before);
  });

  it("cancels at the deadline, time after time, and leaves no backend and no stray error", async () => {
    // The credential takes most of the time each call has, so the statement is still inside
    // its timeout on the server when the platform's own timer ends the call.
    slowCredentialMs = 1100;
    await calls().close();
    const round = (number: number) =>
      Promise.all(
        [0, 1, 2, 3].map((slot) =>
          failure(
            calls().query({
              ...overTls(),
              limits: { statementTimeoutMs: 300 },
              sql: `select pg_sleep(30) /* deadline ${number}.${slot} */`
            })
          )
        )
      );

    const errors = [];
    for (let number = 0; number < CANCELS / 4; number += 1) errors.push(...(await round(number)));
    slowCredentialMs = 0;

    expect(errors.map((error) => `${error.kind} ${error.sqlState}`)).toEqual(
      Array.from({ length: CANCELS }, () => "timeout undefined")
    );
    await expectNothingLeft();
  });

  it("cancels when the caller aborts, time after time, and leaves no backend and no stray error", async () => {
    const errors = [];
    for (let number = 0; number < CANCELS; number += 1) {
      const abort = new AbortController();
      const call = failure(
        calls().query({
          ...overTls(),
          signal: abort.signal,
          sql: `select pg_sleep(30) /* aborted ${number} */`
        })
      );
      await customer.runningQuery(writer, `aborted ${number} `);
      abort.abort();
      errors.push(await call);
    }

    expect(errors.map((error) => error.kind)).toEqual(
      Array.from({ length: CANCELS }, () => "cancelled")
    );
    await expectNothingLeft();
    expect(await calls().query({ ...overTls(), sql: "select 1 as one" })).toMatchObject({
      rows: [{ one: 1 }]
    });
  });
});
