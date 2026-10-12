import type { JsonValue } from "@vivd-catalyst/core";
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
  query: { containerStepRunId?: string; status?: string; iteration?: number; limit?: number } = {}
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
