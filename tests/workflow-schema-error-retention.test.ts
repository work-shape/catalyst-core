import { workflowStepFiles } from "./support/workflow-step-files";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import { createCodeStepJobs } from "@work-shape/catalyst-workflows";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";
import { clientInstanceId } from "./support/access-instance";
import { withTestSql } from "./support/test-sql";

let open: WorkflowFixture | undefined;
let directory: string | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it.each(["code_input", "code_output", "output"])(
  "stores %s schema failures by position without data keys through pruning",
  async (side) => {
    const sensitive = "Sensitive Person";
    // Both object levels have data keys, with a list between them.
    const value = { [sensitive]: [{ [sensitive]: "invalid" }] };
    const strict = {
      type: "object",
      additionalProperties: {
        type: "array",
        items: { type: "object", additionalProperties: { type: "integer" } }
      }
    };
    const wrapped = { type: "object", properties: { payload: strict } };
    const definitions = publishedDefinitions();
    definitions.publish({
      id: "probe",
      name: "Probe",
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: side === "output" ? wrapped : { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "code",
          name: "Code",
          type: "code",
          file: "probe.py",
          input: { payload: { ref: { step: "start", path: "input" } } },
          inputSchema: side === "code_input" ? wrapped : { type: "object" },
          outputSchema: side === "code_output" ? wrapped : { type: "object" }
        },
        {
          id: "result",
          name: "Result",
          type: "output",
          input: { payload: { ref: { step: "code", path: "payload" } } }
        }
      ]
    });
    let days = 0;
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      {
        definitions: definitions.source,
        now: () => new Date(Date.now() + days * 86_400_000),
        codeRunner: { timeoutSeconds: 20 },
        stepFiles: workflowStepFiles(["steps/probe.py"], async () =>
          new TextEncoder().encode(
            `import json\nwith open("output.json", "w") as out:\n    json.dump(${JSON.stringify({ payload: value })}, out)`
          )
        )
      }
    );
    directory = await mkdtemp(join(tmpdir(), "wf-retention-fix-code-"));
    const worker = t.worker([
      ...t.workflows.jobHandlers,
      ...createCodeStepJobs({
        clientInstanceId,
        stores: t.stores,
        stepFiles: t.stepFiles,
        sandbox: new LocalWorkspaceCommandProcessExecutor(),
        tempRoot: directory,
        slots: 1,
        timeoutSeconds: 20,
        limits: {
          cpuCount: 1,
          memoryBytes: 128 * 1024 * 1024,
          pidsLimit: 64,
          scratchBytes: 16 * 1024 * 1024
        }
      }).handlers
    ]);
    const started = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow: "probe" },
          payload: { input: value }
        })
      ).json()
    );
    const ended = await t.finish(started.id, worker);
    expect(ended.error?.code).toBe(`${side}_invalid`);
    expect(ended.error?.message).toContain("at field 1, field 1, item 1, field 1: must be integer");
    expect(JSON.stringify(ended.error).includes(sensitive)).toBe(false);
    // Assert the durable rows, not just the response, on both sides of retention.
    const storedErrors = () =>
      withTestSql(async (sql) => {
        const rows = await sql<
          { error: unknown }[]
        >`select error from workflow_runs where id = ${ended.id}
        union all select error from workflow_step_runs where run_id = ${ended.id} and error is not null`;
        expect(rows).toHaveLength(2);
        for (const row of rows)
          expect(row.error).toMatchObject({
            code: ended.error?.code,
            message: ended.error?.message
          });
        expect(JSON.stringify(rows).includes(sensitive)).toBe(false);
      });
    await storedErrors();
    days = 31;
    expect((await t.workflows.pruneRunData()).runs).toBe(1);
    await storedErrors();
  }
);
