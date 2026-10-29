import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ModelUsageLimitReachedError,
  type OperationDefinition,
  type OperationSource
} from "@work-shape/catalyst-core";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// A Workflow run that a usage limit stops (limits spec 3.1, LU-5): the run ends `limit_reached`
// with the limit named, the loop around the step stops at the first item, and the same Workflow
// started again once the limit no longer holds goes through. Without the change the run ended
// `failed`, like a fault of the Workflow, and the limit was lost on the way.

const SEARCH = "fixture_search.run";

/** An operation that makes a model call of its own, as the embedding of a search does. */
function searchSource(state: { limited: boolean; calls: number }): OperationSource {
  const definition: OperationDefinition = {
    name: SEARCH,
    effect: "reading",
    scope: null,
    auth: "principal",
    action: "connection.use",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ hits: z.number() }),
    timeoutMs: 5_000,
    resource: () => undefined,
    execute() {
      state.calls += 1;
      if (state.limited) {
        throw new ModelUsageLimitReachedError("A usage limit refused the call", {
          period: "month",
          metric: "costMicros",
          scope: "workspace"
        });
      }
      return Promise.resolve({ hits: 2 });
    }
  };
  return {
    resolve: (name) => Promise.resolve(name === SEARCH ? definition : undefined),
    list: () => Promise.resolve({ operations: [definition], truncated: [] })
  };
}

const searchEachClient = {
  id: "search-each",
  name: "Search for each client",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "clients",
      name: "Read the clients",
      type: "operation",
      operation: "connection.crm.echo",
      input: { text: { value: "clients" } }
    },
    {
      id: "each_client",
      name: "For each client",
      type: "loop",
      items: { step: "clients", path: "clients" },
      itemLabel: "id",
      steps: [
        {
          id: "search",
          name: "Search",
          type: "operation",
          operation: SEARCH,
          input: { query: { ref: { step: "each_client", path: "id" } } }
        }
      ]
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { done: { ref: { step: "each_client", path: "done" } } }
    }
  ]
};

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

async function ready() {
  const definitions = publishedDefinitions();
  definitions.publish(searchEachClient);
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source }
  );
  const state = { limited: true, calls: 0 };
  t.operationCalls.registry.addSource(searchSource(state));
  t.state.centralSettings = [...t.state.centralSettings, { operation: SEARCH, value: "allow" }];
  const run = async () => {
    const response = await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: searchEachClient.id },
      payload: { input: {} }
    });
    const started = runSchema.parse(response.json());
    return t.finish(started.id, t.worker());
  };
  return { t, state, run };
}

describe("an operation step that a usage limit refuses", () => {
  it("ends the run as limit_reached, names the limit and stops the loop at the first item", async () => {
    const { t, state, run } = await ready();
    const ended = await run();

    expect(ended.status).toBe("limit_reached");
    expect(ended.error).toMatchObject({
      code: "MODEL_USAGE_LIMIT_REACHED",
      usageLimit: { period: "month", metric: "costMicros", scope: "workspace" }
    });
    // Every further item would meet the same limit: nothing was asked a second time.
    expect(state.calls).toBe(1);
    const steps = await stepRunsOf(t, ended.id);
    expect(steps.find((step) => step.stepId === "search")).toMatchObject({
      status: "failed",
      error: { code: "MODEL_USAGE_LIMIT_REACHED" }
    });
  }, 60_000);

  it("lets the same Workflow run through once the limit no longer holds", async () => {
    const { state, run } = await ready();
    expect((await run()).status).toBe("limit_reached");

    state.limited = false;
    expect((await run()).status).toBe("done");
  }, 60_000);
});
