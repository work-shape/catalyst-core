import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import { child, children, parent } from "./support/workflow-children";
import {
  publishedDefinitions,
  runSchema,
  stepRunsSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import { readyWorkflows } from "./support/workflow-runs";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

describe("outside reads of real child Workflow runs", () => {
  it("answers the root and child with the same outside boundary and existing key rights", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    const definition = parent();
    const trigger = definition.steps[0];
    if (trigger?.type !== "trigger") throw new Error("Missing trigger");
    trigger.triggers = [...trigger.triggers, { kind: "outside" }];
    definitions.publish(definition);
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, definitions: definitions.source }
    );
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    await t.seed("crm", {
      operations: [operationOf("echo", { exposure: ["workflow", "outside"] })]
    });
    t.setBehaviour((_operation, input) =>
      Promise.resolve({ value: z.object({ text: z.string() }).parse(input).text })
    );
    const starter = await personalKeyToken(
      t,
      (await issuePersonalKey(t, ["workflow.read", "workflow.write", "workflow.use"], t.root.id))
        .secret
    );
    const reporter = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Reporter",
      permissions: ["config_assets.read"]
    });
    for (const action of ["workflow.read", "workflow.read_run_data"])
      await t.allow({ kind: "service_principal", id: reporter.id }, action);
    const issued = await t.expectOk(t.root.id, "api_credentials.create", {
      params: { servicePrincipalId: reporter.id },
      payload: {
        name: "Reporting",
        scopes: ["config_assets:read"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    const reader = await personalKeyToken(
      t,
      z.object({ secret: z.string() }).parse(issued.json()).secret
    );
    const summaryOnly = await personalKeyToken(
      t,
      (await issuePersonalKey(t, ["workflow.read"], t.root.id)).secret
    );
    for (const outside of [true, false]) {
      const started = await t.expectOk(t.root.id, "workflows.start", {
        params: { workflow: definition.id },
        payload: { input: {} },
        ...(outside ? { headers: starter } : {})
      });
      const root = await t.finish(runSchema.parse(started.json()).id);
      expect(root.status, JSON.stringify(root.error)).toBe("done");
      const [spawned] = await children(t, root.id);
      expect(spawned).toBeDefined();
      if (!spawned) throw new Error("Missing child");
      expect(spawned).toMatchObject({ trigger: "parent", rootRunId: root.id });
      for (const run of [root, spawned]) {
        for (const headers of [starter, reader]) {
          const response = await t.expectOk(t.root.id, "workflows.get_run", {
            params: { runId: run.id },
            headers
          });
          expect(runSchema.parse(response.json()).outputPreview !== undefined).toBe(outside);
        }
      }
      const steps = await t.expectOk(t.root.id, "workflows.list_step_runs", {
        params: { runId: spawned.id },
        headers: reader
      });
      const read = stepRunsSchema.parse(steps.json()).items.find((step) => step.stepId === "read");
      expect(read?.inputPreview !== undefined).toBe(outside);
      expect(read?.outputPreview !== undefined).toBe(outside);
      const summary = await t.expectOk(t.root.id, "workflows.get_run", {
        params: { runId: spawned.id },
        headers: summaryOnly
      });
      expect(runSchema.parse(summary.json()).outputPreview).toBeUndefined();
      const listed = await t.expectOk(t.root.id, "workflows.list_runs", {
        params: { workflow: "child" },
        headers: reader
      });
      const current = z
        .object({ items: z.array(runSchema) })
        .parse(listed.json())
        .items.find((entry) => entry.id === spawned.id);
      expect(current?.outputPreview !== undefined).toBe(outside);
      expect(
        await t.stores.workflowRuns.readRun({ clientInstanceId, id: spawned.id })
      ).toMatchObject({ trigger: "parent" });
    }
  });
});
