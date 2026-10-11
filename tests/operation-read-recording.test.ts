import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  change,
  clientInstanceId,
  createServer,
  errorOf,
  person,
  right,
  secret
} from "./support/operation-server";
import { registeredTestOperations as operations } from "./support/operations";
import { withTestSql } from "./support/test-sql";

// What recording a read costs the database, counted as the driver sends it, and how the
// Operations page reads its default list from a table that holds mostly reads.

interface Sent {
  statement: string;
  parameters: readonly unknown[];
}

const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<Sent[]>();
});

// Every statement sent to Postgres from inside a counted call, as the driver reports it. The
// driver sends a statement in the asynchronous context of the code that awaits it.
vi.mock("postgres", async (importOriginal) => {
  type Connect = (url: string, options?: postgres.Options<Record<string, never>>) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) =>
    actual.default(url, {
      ...options,
      debug: (_connection, statement, parameters) => {
        counted.getStore()?.push({ statement, parameters });
      }
    });
  return { ...actual, default: Object.assign(connect, actual.default) };
});

/** The statements that write the record of a call: its run and its audit rows. */
const recordWrites = (sent: readonly Sent[]) =>
  sent
    .map(({ statement }) => statement.trimStart().toLowerCase())
    .filter((statement) =>
      /^(?:insert into|update) "(?:operation_runs|audit_events)"/u.test(statement)
    )
    .map((statement) => statement.split('"').slice(0, 2).join('"').concat('"'));

describe("a read of an operation that does not record every call", () => {
  const read = (view?: "short") => ({
    params: { itemId: "item-1" },
    ...(view ? { query: { view } } : {}),
    headers: { "idempotency-key": "k" }
  });

  // Fails without the change: the read left one run with status `done`, three audit rows and
  // the header.
  it("runs an allowed read and leaves no run, no audit row and no header", async () => {
    const { server, runs, auditRows, executed } = await createServer();
    const response = await server.call("testRunRead", read("short"), person());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ itemId: "item-1", view: "short" });
    expect(executed).toEqual(["testRunRead"]);
    expect(response.headers["operation-run-id"]).toBeUndefined();
    expect(await runs()).toEqual([]);
    expect(await auditRows()).toBe(0);
  });

  // Fails without the change: the binding had no mark, and with the mark ignored the read
  // leaves no run.
  it("records every call of a reading operation that is marked to", async () => {
    const { server, runs, auditTypes } = await createServer({ read: { recordsEveryCall: true } });
    const response = await server.call("testRunRead", read(), person());
    expect(response.statusCode).toBe(200);
    const [run, ...others] = await runs();
    expect(others).toEqual([]);
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({ operation: "testRunRead", effect: "reading", status: "done" });
    expect(run?.decision).toBeUndefined();
    expect(run?.output).toBeUndefined();
    // A reading call takes no key: the same one twice is two runs.
    expect(run?.idempotencyKey).toBeUndefined();
    expect(await auditTypes(run?.id ?? "")).toEqual([
      "operation.authorization_checked:success",
      "operation.completed:success",
      "operation.started:success"
    ]);
  });

  // Fails without the change in the part that matters here: the run of the failed read was
  // written as `running` first. The one statement is counted further down.
  it("records a read that fails as one failed run, with its audit rows and the header", async () => {
    const { server, runs, auditTypes } = await createServer({ read: { fails: true } });
    const created = vi.spyOn(server.stores.operationRuns, "create");
    const response = await server.call("testRunRead", read(), person());
    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.json())).not.toContain(secret);
    const [run, ...others] = await runs();
    expect(others).toEqual([]);
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({
      operation: "testRunRead",
      effect: "reading",
      status: "failed",
      attempt: 1,
      error: { code: "INTERNAL" }
    });
    expect(run?.finishedAt).toEqual(expect.any(String));
    // The run was never `running` in the store: nothing started one.
    expect(created).not.toHaveBeenCalled();
    expect(await auditTypes(run?.id ?? "")).toEqual([
      "operation.authorization_checked:success",
      "operation.failed:failed",
      "operation.started:success"
    ]);
    const stored = await server.call(
      "operations.get_run",
      { params: { runId: run?.id ?? "" } },
      person()
    );
    expect(stored.json()).toMatchObject({ id: run?.id, status: "failed" });
  });

  // Fails without the change: a changing operation that carries the mark was registered.
  it("refuses to register a changing operation that is marked as a read is", async () => {
    const start = createServer({
      register: (route) =>
        route.operation(operations.testRunChange, {
          recordsEveryCall: true,
          execute: (item) => Promise.resolve({ name: item.name })
        })
    }).then(({ server }) => server.call("testRunChange", change("marked"), person()));
    await expect(start).rejects.toThrow(/is changing and is always recorded/u);
  });

  // Fails without the change in that the refused read's run was started as `running`; the
  // rest holds what a refusal has always left, which the change must keep.
  it.each([
    { by: "the policy", readingDefault: "deny", code: "POLICY_DENIED", checked: "success" },
    { by: "a missing right", readingDefault: "allow", code: "FORBIDDEN", checked: "denied" }
  ] as const)(
    "records a read that $by refuses as one denied run",
    async ({ readingDefault, code, checked }) => {
      const { server, runs, auditTypes, executed } = await createServer({ readingDefault });
      const caller =
        code === "FORBIDDEN" ? person({ permissions: right("users.manage") }) : person();
      const created = vi.spyOn(server.stores.operationRuns, "create");
      const response = await server.call("testRunRead", { params: { itemId: "i" } }, caller);
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe(code);
      const [run, ...others] = await runs();
      expect(others).toEqual([]);
      expect(response.headers["operation-run-id"]).toBe(run?.id);
      expect(run).toMatchObject({ operation: "testRunRead", effect: "reading", status: "denied" });
      expect(created).not.toHaveBeenCalled();
      expect(executed).toEqual([]);
      expect(await auditTypes(run?.id ?? "")).toEqual([
        `operation.authorization_checked:${checked}`,
        "operation.denied:denied"
      ]);
      // The caller reads the run of its own refused call.
      const stored = await server.call(
        "operations.get_run",
        { params: { runId: run?.id ?? "" } },
        caller
      );
      expect(stored.statusCode).toBe(200);
      expect(stored.json()).toMatchObject({ id: run?.id, status: "denied" });
    }
  );

  // Fails without the change only if the guardrails were skipped for a read that leaves no run:
  // the before-event must reach the emitter and its answer must refuse the call.
  it("asks the guardrails before a read that leaves no run, and a block refuses it", async () => {
    const allowed = await createServer({
      guardrail: { event: "operation.started", outcome: "block" }
    });
    const passed = await allowed.server.call("testRunRead", { params: { itemId: "i" } }, person());
    expect(passed.statusCode).toBe(200);
    // The question is asked. The after-events of an allowed read are held back and dropped.
    expect(allowed.emitted).toEqual(["operation.before_call:before"]);
    expect(await allowed.runs()).toEqual([]);

    const blocked = await createServer({
      guardrail: { event: "operation.before_call", outcome: "block" }
    });
    const response = await blocked.server.call(
      "testRunRead",
      { params: { itemId: "i" } },
      person()
    );
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe("GUARDRAIL_BLOCKED");
    const [run] = await blocked.runs();
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({ status: "denied", denial: { kind: "guardrail" } });
    expect(blocked.executed).toEqual([]);
    expect(blocked.emitted).toEqual([
      "operation.before_call:before",
      "operation.authorization_checked:after",
      "operation.denied:after"
    ]);
  });
});

describe("what recording a read sends to the database", () => {
  const read = { params: { itemId: "item-1" } };
  async function statementsOf(server: Awaited<ReturnType<typeof createServer>>["server"]) {
    const sent: Sent[] = [];
    const response = await counted.run(sent, () => server.call("testRunRead", read, person()));
    return { response, sent, writes: recordWrites(sent) };
  }

  // Fails without the change: an allowed read sent five statements for its record, the ones
  // the marked read below still sends.
  it("sends no statement for the record of an allowed read, and five for a marked one", async () => {
    const unmarked = await createServer();
    const allowed = await statementsOf(unmarked.server);
    expect(allowed.response.statusCode).toBe(200);
    // The count is of real statements: the call reads the caller's rights.
    expect(allowed.sent.length).toBeGreaterThan(0);
    expect(allowed.writes).toEqual([]);
    expect(allowed.sent.some(({ statement }) => statement.includes("operation_runs"))).toBe(false);

    const marked = await createServer({ read: { recordsEveryCall: true } });
    const recorded = await statementsOf(marked.server);
    expect(recorded.response.statusCode).toBe(200);
    expect(recorded.writes).toEqual([
      'insert into "operation_runs"',
      'insert into "audit_events"',
      'insert into "audit_events"',
      'update "operation_runs"',
      'insert into "audit_events"'
    ]);
  });

  // Fails without the change: a refused or failed read wrote its run in two statements, as
  // `running` first.
  it("writes the run of a refused and of a failed read in one statement", async () => {
    const refusing = await createServer({ readingDefault: "deny" });
    const refused = await statementsOf(refusing.server);
    expect(refused.response.statusCode).toBe(403);
    expect(refused.writes).toEqual([
      'insert into "operation_runs"',
      'insert into "audit_events"',
      'insert into "audit_events"'
    ]);

    const failing = await createServer({ read: { fails: true } });
    const failed = await statementsOf(failing.server);
    expect(failed.response.statusCode).toBe(500);
    expect(failed.writes).toEqual([
      'insert into "operation_runs"',
      'insert into "audit_events"',
      'insert into "audit_events"',
      'insert into "audit_events"'
    ]);
    for (const { sent } of [refused, failed]) {
      const insert = sent.find(({ statement }) => /insert into "operation_runs"/iu.test(statement));
      expect(insert?.parameters).not.toContain("running");
    }
  });
});

describe("the list of changing calls on a table of mostly reads", () => {
  const explainSchema = z.tuple([
    z.object({ "QUERY PLAN": z.tuple([z.object({ Plan: z.unknown() }).loose()]) })
  ]);
  const nodeSchema = z
    .object({
      "Node Type": z.string(),
      "Index Name": z.string().optional(),
      "Scan Direction": z.string().optional(),
      "Relation Name": z.string().optional(),
      Plans: z.array(z.unknown()).default([])
    })
    .loose();
  type PlanNode = z.infer<typeof nodeSchema>;
  function nodesOf(plan: unknown): PlanNode[] {
    const node = nodeSchema.parse(plan);
    return [node, ...node.Plans.flatMap(nodesOf)];
  }
  const RUNS = 200_000;
  /** One run in fifty is a changing call, as on an instance whose reads are all recorded. */
  const CHANGING_EVERY = 50;

  // Fails without the change: there is no filter for the effect and no index for it.
  it("reads one page through the partial index, backwards and without a sort", async () => {
    const { server } = await createServer();
    await withTestSql(async (sql) => {
      await sql`
        insert into operation_runs (
          id, client_instance_id, operation, effect, actor_kind, actor_id, actor, origin_kind,
          origin, input_hash, status, correlation_id, created_at, updated_at
        )
        select
          'oprun_' || n, ${clientInstanceId},
          case when n % ${CHANGING_EVERY} = 0 then 'assets.put' else 'assets.get' end,
          case when n % ${CHANGING_EVERY} = 0 then 'changing' else 'reading' end,
          'user', 'usr_' || (n % 500), '{"kind": "user", "id": "usr", "label": "User"}', 'user',
          '{"kind": "user"}', 'hash', 'done', 'corr_' || n,
          timestamptz '2026-01-01' + make_interval(secs => n),
          timestamptz '2026-01-01' + make_interval(secs => n)
        from generate_series(1, ${RUNS}) n`;
      await sql`vacuum analyze operation_runs`;
    });

    const pageOf = async (after?: readonly string[]) => {
      const sent: Sent[] = [];
      const runs = await counted.run(sent, () =>
        server.stores.operationRuns.list({
          clientInstanceId,
          filters: { effect: "changing" },
          page: { limit: 51, ...(after ? { after } : {}) }
        })
      );
      const [listed] = sent.filter(({ statement }) => statement.includes("operation_runs"));
      if (!listed) throw new Error("The list sent no statement");
      const nodes = await withTestSql(async (sql) => {
        const explained = await sql.unsafe(
          `explain (format json) ${listed.statement}`,
          listed.parameters.map((parameter) =>
            typeof parameter === "string" || typeof parameter === "number" ? parameter : null
          )
        );
        return nodesOf(explainSchema.parse(explained)[0]["QUERY PLAN"][0].Plan);
      });
      return { runs, nodes };
    };

    const first = await pageOf();
    expect(first.runs).toHaveLength(51);
    expect(first.runs.every((run) => run.effect === "changing")).toBe(true);
    expect(first.runs[0]?.id).toBe(`oprun_${RUNS}`);
    const last = first.runs[50];
    if (!last) throw new Error("The page is full");
    const second = await pageOf([last.createdAt, last.id]);
    expect(second.runs[0]?.id).toBe(`oprun_${RUNS - 51 * CHANGING_EVERY}`);

    for (const { nodes } of [first, second]) {
      expect(nodes.map((node) => node["Node Type"])).not.toContain("Sort");
      const scans = nodes.filter((node) => node["Relation Name"] === "operation_runs");
      expect(
        scans.map((node) => `${node["Node Type"]} ${node["Scan Direction"]} ${node["Index Name"]}`)
      ).toEqual(["Index Scan Backward operation_runs_changing_list_idx"]);
    }
  });
});
