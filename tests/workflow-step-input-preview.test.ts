import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@work-shape/catalyst-core";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import {
  publishedDefinitions,
  stepRunsSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import { CLIENTS, NOTE, notifyClients, readyWorkflows, start } from "./support/workflow-runs";
import { withTestSql } from "./support/test-sql";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const stepRunsAs = async (
  t: WorkflowFixture,
  user: string,
  runId: string,
  query: { containerStepRunId?: string } = {}
) =>
  stepRunsSchema.parse(
    (await t.expectOk(user, "workflows.list_step_runs", { params: { runId }, query })).json()
  ).items;

/** `notify-clients` whose list is a dataset, and whose loop hands each row to a changing call. */
function datasetLoop() {
  const manifest = notifyClients();
  return {
    ...manifest,
    steps: manifest.steps.map((step) =>
      step.id === "clients"
        ? { ...step, dataset: { at: "clients" } }
        : step.id === "each_client"
          ? {
              ...step,
              steps: [
                {
                  id: "send",
                  name: "Send the note",
                  type: "operation",
                  operation: "connection.crm.write",
                  input: { row: { ref: { step: "each_client", path: "" } } }
                }
              ]
            }
          : step
    )
  };
}

describe("WF-PANEL-1a the input of a step run", () => {
  it("is shown only with workflow.read_run_data, the run's input included", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(notifyClients());
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source }
    );
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
    const run = await t.finish((await start(t)).id);
    const reader = await stepRunsAs(t, t.lena.id, run.id);
    expect(reader.map((step) => step.key)).toContain("clients");
    expect(reader.filter((step) => step.inputPreview)).toEqual([]);
    // The admin role holds workflow.read_run_data: the run's input reaches the first read.
    const admin = await stepRunsAs(t, t.root.id, run.id);
    expect(
      JSON.parse(admin.find((step) => step.key === "clients")?.inputPreview?.text ?? "null")
    ).toEqual({ text: NOTE });
  });

  it("keeps no dataset row, for any reader, beyond the dataset", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(datasetLoop());
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source, datasetObjects: new MemoryObjectStorage() }
    );
    // The changing call answers nothing of its input, so only an input preview could carry a row.
    const rows = CLIENTS.map((client) => ({ ...client, iban: `DE00-${client.id}-SECRET` }));
    t.setBehaviour((operation) =>
      Promise.resolve<JsonValue>(operation === "echo" ? { clients: rows } : { ok: true })
    );
    await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    const loop = (await stepRunsAs(t, t.root.id, run.id)).find(
      (step) => step.key === "each_client"
    );
    for (const user of [t.lena.id, t.root.id]) {
      const body = await stepRunsAs(t, user, run.id, { containerStepRunId: loop?.id ?? "" });
      expect(body.map((step) => step.key)).toContain("each_client[0].send");
      expect(JSON.stringify(body)).not.toContain("SECRET");
    }
    const stored = await withTestSql(
      (sql) => sql`select input from workflow_step_runs where run_id = ${run.id}
        and step_id = 'send'`
    );
    expect(stored.map((row) => row.input)).toEqual(CLIENTS.map(() => null));
  });

  it("stores only the preview, cut and marked as cut", async () => {
    const definitions = publishedDefinitions();
    const manifest = notifyClients();
    definitions.publish({
      ...manifest,
      inputs: { type: "object" },
      steps: [
        manifest.steps[0],
        {
          id: "large",
          name: "Large input",
          type: "operation",
          operation: "connection.crm.write",
          input: { text: { value: "x".repeat(4_000) } }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source }
    );
    t.setBehaviour(() => Promise.resolve({ ok: true }));
    const run = await t.finish((await start(t)).id);
    const [row] = await withTestSql(
      (sql) => sql`select input from workflow_step_runs where run_id = ${run.id}
        and step_id = 'large'`
    );
    const preview = { text: `{"text":"${"x".repeat(1_991)}`, truncated: true };
    expect(row?.input).toEqual({ preview });
    const step = (await stepRunsAs(t, t.root.id, run.id)).find((step) => step.key === "large");
    expect(step?.inputPreview).toEqual(preview);
  });
});
