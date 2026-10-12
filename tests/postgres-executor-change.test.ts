import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPostgresExecutor,
  type PostgresChangeInput,
  type PostgresExecutor
} from "@vivd-catalyst/postgres-connector";
import { required } from "./support/assertions";
import { executorFailure as failure, useCustomerDatabase } from "./support/customer-database";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";

// The one call of the executor that writes: `change`, for a database the platform manages
// itself. The account here may insert into `reporting.visits` and nothing else.

describe("a change through the Postgres executor", () => {
  const customer = useCustomerDatabase();
  let executor: PostgresExecutor | undefined;

  const calls = () => required(executor);
  const asWriter = (further: Partial<PostgresChangeInput> = {}): PostgresChangeInput => ({
    location: {
      host: customer.host,
      port: customer.port,
      database: customer.database,
      user: customer.writer,
      tls: "off",
      schemas: []
    },
    credentialHandle: "writer-password",
    timeoutMs: 5_000,
    ...further
  });
  const visits = async () =>
    z
      .array(z.object({ note: z.string() }))
      .parse(await customer.sql`select note from reporting.visits order by id`)
      .map((row) => row.note);

  beforeAll(() => {
    executor = createPostgresExecutor({
      secrets: { getSecret: (name) => Promise.resolve(customer.passwords.get(name)) },
      pinAddress: () => Promise.resolve({ allowed: true, address: customer.address })
    });
  });

  afterAll(async () => {
    await executor?.close();
  });

  it("commits the statements of one change together and answers what they return", async () => {
    const counted = await calls().change(asWriter(), async (change) => {
      await change.run("insert into reporting.visits (note) values ($1)", ["first"]);
      await change.script("insert into reporting.visits (note) values ('second'); select 1;");
      return change.run("select count(*)::integer as count from reporting.visits");
    });

    expect(counted).toEqual([{ count: 2 }]);
    expect(await visits()).toEqual(["first", "second"]);
  });

  it("rolls back everything when the work throws or a statement fails", async () => {
    const before = await visits();
    const thrown = calls().change(asWriter(), async (change) => {
      await change.run("insert into reporting.visits (note) values ($1)", ["lost"]);
      throw new Error("the work gave up");
    });
    const refused = calls().change(asWriter(), async (change) => {
      await change.run("insert into reporting.visits (note) values ($1)", ["lost"]);
      await change.script("insert into reporting.nowhere (note) values ('x')");
    });

    // Whatever the work throws leaves the executor as its own error, without the cause.
    expect(await failure(thrown)).toMatchObject({ kind: "failed" });
    expect(await failure(refused)).toMatchObject({ kind: "query_rejected", sqlState: "42P01" });
    expect(await visits()).toEqual(before);
  });

  it("runs outside of a transaction when the change says so", async () => {
    const firstStatement = (further: Partial<PostgresChangeInput> = {}) =>
      calls().change(asWriter(further), (change) =>
        change.run("select now() = statement_timestamp() as first_statement")
      );

    // Inside a transaction `now()` is the time of its `begin`, which came before.
    expect(await firstStatement()).toEqual([{ first_statement: false }]);
    expect(await firstStatement({ transaction: false })).toEqual([{ first_statement: true }]);
  });

  it("ends a change at its own time limit", async () => {
    const slow = calls().change(asWriter({ timeoutMs: 200 }), (change) =>
      change.run("select pg_sleep(30)")
    );

    expect(await failure(slow)).toMatchObject({ kind: "timeout" });
  });
});
