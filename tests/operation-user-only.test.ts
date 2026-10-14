import { afterEach, describe, expect, it } from "vitest";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

// An operation registered with `auth: "user"` is one a person calls, such as
// `workspaces.create`, whose caller becomes the Owner of what it makes. Over HTTP a service
// principal is refused at the route. A step of a Workflow calls as its service principal and
// takes no route, so the call path refuses it there too: before the operation is executed,
// with a recorded denial that says why.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

/** `notify-clients` with one step in place of its read, its loop and its result's input. */
function withStep(step: Record<string, unknown>) {
  const definition = notifyClients();
  const [trigger, , , result] = definition.steps;
  return { ...definition, steps: [trigger, step, { ...result, input: {} }] };
}

describe("an operation a person calls, called by a service principal", () => {
  it("is refused before it runs, with a recorded denial and the reason on the step", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(
      withStep({
        id: "space",
        name: "Make a workspace",
        type: "operation",
        operation: "workspaces.create",
        input: { name: { value: "Made by a Workflow" } }
      })
    );
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source }
    );
    // The policy lets the call through. The operation names no right of its own: every person
    // may call it, and the principal is still none.
    t.state.centralSettings = [
      ...t.state.centralSettings,
      { operation: "workspaces.create", value: "allow" }
    ];

    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("FORBIDDEN");
    expect(run.error?.message).toContain("Only a person may call 'workspaces.create'");
    const [, step] = await stepRunsOf(t, run.id);
    expect(step).toMatchObject({ key: "space", status: "failed" });

    const calls = (await t.stores.operationRuns.list({ clientInstanceId })).filter(
      (call) => call.operation === "workspaces.create"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "denied",
      actor: { kind: "service_principal", id: t.principal.id },
      error: { code: "FORBIDDEN" },
      denial: { kind: "forbidden", reason: "user_only" }
    });
    // No right opens it, so the refusal names none.
    expect(calls[0]?.denial).not.toHaveProperty("action");
    const workspaces = await t.call(t.root.id, "workspaces.list");
    expect(JSON.stringify(workspaces.json())).not.toContain("Made by a Workflow");
  });
});
