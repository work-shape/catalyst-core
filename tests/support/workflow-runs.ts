import type { JsonValue } from "@work-shape/catalyst-core";
import { withTestSql } from "./test-sql";
import {
  runSchema,
  stepRunsSchema,
  workflowFixture,
  type WorkflowFixture
} from "./workflow-instance";

// What the tests of Workflow Runs share: the instance with its Connection and its principal,
// the start and the reads through the API, and the Workflow `notify-clients`, which reads a
// list from the Connection `crm` and makes one changing call per item of it.

export const NOTE = "Quarterly figures are ready";
export const CLIENTS = [{ id: "client-anna" }, { id: "client-bert" }, { id: "client-cleo" }];

/**
 * An instance whose Connection answers three clients and whose principal may use it. `opened`
 * is handed the instance as soon as it exists, so the test closes it whatever follows.
 */
export async function readyWorkflows(
  opened: (fixture: WorkflowFixture) => void,
  options: Parameters<typeof workflowFixture>[0] = {}
) {
  const t = await workflowFixture(options);
  opened(t);
  await t.seedCrm();
  t.setBehaviour((operation, input) =>
    Promise.resolve<JsonValue>(operation === "echo" ? { clients: CLIENTS } : { received: input })
  );
  t.state.centralSettings = [{ operation: "connection.crm.write", value: "allow" }];
  // AP-10: the principal holds the right of its calls by a grant written to the store.
  await t.allow({ kind: "service_principal", id: t.principal.id }, "connection.use");
  return t;
}

export async function start(t: WorkflowFixture, userId = t.root.id, workflow = "notify-clients") {
  const response = await t.expectOk(userId, "workflows.start", {
    params: { workflow },
    payload: { input: { note: NOTE } }
  });
  return runSchema.parse(response.json());
}

export async function stepRunsOf(
  t: WorkflowFixture,
  runId: string,
  query: {
    topLevel?: "true" | "false";
    containerStepRunId?: string;
    status?: string;
    iteration?: number;
    limit?: number;
  } = {}
) {
  const response = await t.expectOk(t.root.id, "workflows.list_step_runs", {
    params: { runId },
    query
  });
  return stepRunsSchema.parse(response.json()).items;
}

/** `notify-clients` as a test publishes it, with the loop's options and steps as given. */
export function notifyClients(loop: Record<string, unknown> = {}, inner: unknown[] = []) {
  const ref = (step: string, path: string) => ({ ref: { step, path } });
  return {
    id: "notify-clients",
    name: "Notify clients",
    runAs: "workflow-runner",
    inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "clients",
        name: "Read the clients",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: ref("start", "input.note") }
      },
      {
        id: "each_client",
        name: "For each client",
        type: "loop",
        items: { step: "clients", path: "clients" },
        itemLabel: "id",
        ...loop,
        steps: [
          {
            id: "send",
            name: "Send the note",
            type: "operation",
            operation: "connection.crm.write",
            input: { client: ref("each_client", "id"), note: ref("start", "input.note") }
          },
          ...inner
        ]
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { sent: ref("each_client", "done"), failed: ref("each_client", "failed") }
      }
    ]
  };
}

/**
 * A Connection that answers these clients and fails the changing call of the named ones, as an
 * outside system does that is down for them.
 */
export const failingFor =
  (failing: readonly string[], clients: readonly { id: string }[] = CLIENTS) =>
  (operation: string, input: JsonValue): Promise<JsonValue> => {
    if (operation === "echo" && JSON.stringify(input).includes(NOTE)) {
      return Promise.resolve({ clients: [...clients] });
    }
    return failing.some((client) => JSON.stringify(input).includes(`"${client}"`))
      ? Promise.reject(new Error("The outside system is down"))
      : Promise.resolve({ received: input });
  };

export const writesOf = (t: WorkflowFixture) =>
  t.executed.filter((call) => call.operation === "write").map((call) => call.input);

/** What the Connection of these tests answers: the clients to a read, its input to a write. */
export const answer = (operation: string, input: JsonValue): JsonValue =>
  operation === "echo" ? { clients: CLIENTS } : { received: input };

/**
 * A Connection whose first call of one operation does not answer until the test lets it go.
 * `entered` resolves when that call is with the outside system.
 */
export function holdingFirst(
  t: WorkflowFixture,
  held: "echo" | "write",
  /** Receives what lets the held call go, so the test lets it go when it ends. */
  hanging: (() => void)[]
) {
  let first = true;
  let entered: () => void = () => undefined;
  let letGo: () => void = () => undefined;
  const inCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  hanging.push(letGo);
  // A call may take as long as a Connection lets any call take.
  t.state.limits = { ...t.state.limits, callTimeoutMs: 30_000 };
  t.setBehaviour((operation, input) => {
    if (operation !== held || !first) return Promise.resolve(answer(operation, input));
    first = false;
    entered();
    return gate.then(() => answer(operation, input));
  });
  return { inCall, letGo };
}

/** Runs passes of a worker until the held call is with the outside system. */
export async function reach(t: WorkflowFixture, inCall: Promise<void>) {
  const worker = t.worker();
  let there = false;
  const arrived = inCall.then(() => {
    there = true;
  });
  for (let pass = 0; pass < 20 && !there; pass++) {
    const running = worker.runDue();
    await Promise.race([running, arrived]);
  }
  if (!there) throw new Error("The held call was not reached");
  return worker;
}

/**
 * Makes each step job that waits out its backoff after a failed or lost attempt due at once, so
 * a test does not sleep through the wait. Returns each wait it cut short, in milliseconds from
 * the start of the attempt before it. A wait that gives back its attempt, as after a 429, stays.
 */
export const skipStepBackoffs = () => skipWaits(true);

/** Makes each waiting step job due at once, a deferral among them; see `skipStepBackoffs`. */
export const skipStepWaits = () => skipWaits(false);

async function skipWaits(backoffsOnly: boolean): Promise<number[]> {
  return withTestSql(async (sql) => {
    const rows = await sql<{ wait_ms: number }[]>`
      with waiting as (
        select id, run_after - started_at as wait from platform_jobs
        where kind = 'workflow_run.execute_step' and status = 'queued' and run_after > now()
          and (${!backoffsOnly} or error_code is not null)
        for update
      )
      update platform_jobs set run_after = now() from waiting
      where platform_jobs.id = waiting.id
      returning (extract(epoch from waiting.wait) * 1000)::float8 as wait_ms`;
    return rows.map((row) => row.wait_ms);
  });
}
