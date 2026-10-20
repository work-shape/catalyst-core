import { clientInstanceId } from "./access-instance";
import { MemoryObjectStorage } from "./memory-object-storage";
import type { WorkflowFixture } from "./workflow-instance";
import { notifyClients, readyWorkflows } from "./workflow-runs";

// The Workflow that continues as new of tests/workflow-continue-as-new.test.ts and its scale
// test, and the helpers that publish it and run its chain of histories to the end.

export function definition(after?: number) {
  return {
    ...notifyClients({ continueAsNew: { position: "offset", ...(after ? { after } : {}) } }),
    labels: { customer: { value: "Acme" } },
    onFailure: "notify" as const,
    limits: { stepRuns: 20_000 },
    inputs: {
      type: "object",
      properties: { note: { type: "string" }, offset: { type: "integer" } },
      required: ["note"]
    },
    steps: notifyClients({
      continueAsNew: { position: "offset", ...(after ? { after } : {}) }
    }).steps.map((step) => (step.id === "clients" ? { ...step, dataset: { at: "clients" } } : step))
  };
}

export const runs = async (t: WorkflowFixture) =>
  t.stores.workflowRuns.listRuns({
    clientInstanceId,
    workflow: "notify-clients",
    page: { limit: 100 }
  });

export async function finishChain(t: WorkflowFixture) {
  const worker = t.worker();
  for (let pass = 0; pass < 100; pass++) {
    await worker.runDue();
    const chain = await runs(t);
    if (chain.some((run) => ["done", "failed", "limit_reached", "cancelled"].includes(run.status)))
      return chain;
  }
  throw new Error(`The continuation chain did not end: ${JSON.stringify(await runs(t))}`);
}

export async function readyPublished(
  opened: (fixture: WorkflowFixture) => void,
  manifest: unknown
) {
  const t = await readyWorkflows(opened, {
    definitions: "assets",
    datasetObjects: new MemoryObjectStorage()
  });
  const params = { kind: "workflow", name: "notify-clients" };
  const draft = await t.expectOk(t.admin.id, "assets.put", {
    params,
    payload: { config: { name: "notify-clients", manifest }, expectedRevision: null }
  });
  await t.expectOk(t.root.id, "assets.publish", {
    params,
    payload: { revision: draft.json().revision }
  });
  return t;
}
