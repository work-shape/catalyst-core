import { afterEach, expect, it } from "vitest";
import { parseWorkflowManifest, workflowContinuationIssues } from "@work-shape/catalyst-workflows";
import type { WorkflowManifest, WorkflowStep } from "@work-shape/catalyst-core";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";
import type { WorkflowFixture } from "./support/workflow-instance";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

function manifest(): Omit<WorkflowManifest, "steps"> & { steps: WorkflowStep[] } {
  const parsed = parseWorkflowManifest({
    ...notifyClients({ continueAsNew: { position: "offset" } }),
    inputs: {
      type: "object",
      properties: { note: { type: "string" }, offset: { type: "integer" } },
      required: ["note"]
    }
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return { ...parsed.manifest, steps: [...parsed.manifest.steps] };
}
const write: WorkflowStep = {
  id: "before",
  name: "Before",
  type: "operation",
  operation: "connection.crm.write",
  input: {}
};
const notify: WorkflowStep = {
  id: "notice",
  name: "Notice",
  type: "notify",
  to: { users: ["tester"] },
  channels: ["inbox"],
  title: { value: "Notice" },
  text: { value: "Text" }
};
const child: WorkflowStep = {
  id: "child",
  name: "Child",
  type: "workflow",
  workflow: "another",
  input: {}
};
function loop(id: string, steps: WorkflowStep[], continues = false): WorkflowStep {
  return {
    id,
    name: id,
    type: "loop",
    items: { step: "clients", path: "clients" },
    steps,
    ...(continues ? { continueAsNew: { position: "offset" } } : {})
  };
}
function before(step: WorkflowStep) {
  const base = manifest();
  base.steps.splice(2, 0, step);
  return base;
}
function after(continues: boolean): WorkflowManifest {
  const base = manifest();
  base.steps.splice(-1, 0, loop("later", [{ ...write, id: "later_write" }], continues));
  return base;
}
function enclosing(step: WorkflowStep, later = false): WorkflowManifest {
  const base = manifest();
  const continuation = loop("inner", [{ ...write, id: "inner_write" }], true);
  base.steps.splice(2, 1, loop("each_client", [continuation]));
  base.steps.splice(later ? -1 : 2, 0, step);
  return base;
}
const refused = [
  {
    name: "loop A then plain loop B",
    make: () => after(false),
    step: "later",
    rule: "cannot follow",
    de: "darf nicht nach"
  },
  {
    name: "two continueAsNew loops",
    make: () => after(true),
    step: "later",
    rule: "cannot follow",
    de: "darf nicht nach"
  },
  {
    name: "write before continuation",
    make: () => before(write),
    step: "before",
    rule: "cannot precede",
    de: "darf nicht vor"
  },
  {
    name: "notify before continuation",
    make: () => before(notify),
    step: "notice",
    rule: "cannot precede",
    de: "darf nicht vor"
  },
  {
    name: "child start before continuation",
    make: () => before(child),
    step: "child",
    rule: "cannot precede",
    de: "darf nicht vor"
  },
  {
    name: "loop containing a write before continuation",
    make: () => before(loop("earlier", [write])),
    step: "earlier",
    rule: "cannot precede",
    de: "darf nicht vor"
  },
  {
    name: "write at enclosing level",
    make: () => enclosing(write),
    step: "before",
    rule: "cannot precede",
    de: "darf nicht vor"
  },
  {
    name: "loop after continuation at enclosing level",
    make: () => enclosing(loop("later", [write]), true),
    step: "later",
    rule: "cannot follow",
    de: "darf nicht nach"
  },
  ...[3, 4].map((stepRuns) => ({
    name: `flat loop at stepRuns ${stepRuns}`,
    make: () => ({ ...manifest(), limits: { stepRuns } }),
    step: "each_client",
    rule: `needs at least 5 step runs`,
    de: "benötigt mindestens 5 Schritte"
  }))
];

it.each(refused)(
  "refuses $name at publish and before opening a draft test run",
  async ({ make, step, rule, de }) => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    if (step === "child") {
      const childDefinition = {
        ...manifest(),
        id: "another",
        inputs: { type: "object" },
        steps: [
          {
            id: "start",
            name: "Start",
            type: "trigger",
            triggers: [{ kind: "manual" }, { kind: "parent" }]
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      };
      const params = { kind: "workflow", name: "another" };
      const saved = await t.expectOk(t.admin.id, "assets.put", {
        params,
        payload: { config: { name: "another", manifest: childDefinition }, expectedRevision: null }
      });
      await t.expectOk(t.root.id, "assets.publish", {
        params,
        payload: { revision: saved.json().revision }
      });
    }
    const definition = make();
    const address = { kind: "workflow", name: definition.id };
    const saved = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: { name: definition.id, manifest: definition }, expectedRevision: null }
    });
    const published = await t.call(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: saved.json().revision }
    });
    const tested = await t.call(t.root.id, "workflows.test", {
      params: { workflow: definition.id },
      payload: { input: { note: "Guard" } }
    });
    for (const response of [published, tested]) {
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.message).toContain(`'${step}'`);
      expect(response.json().error.message).toContain(rule);
      expect(response.json().error.message).toContain(de);
      if (definition.limits?.stepRuns) {
        expect(response.json().error.message).toContain(
          `limits.stepRuns of ${definition.limits.stepRuns}`
        );
        expect(response.json().error.message).toContain(
          `limits.stepRuns erlaubt ${definition.limits.stepRuns}`
        );
      }
    }
  }
);

it.each(["read prefix", "read-only earlier loop", "code prefix", "non-loop tail"])(
  "publishes and tests a continuation as the last loop with %s",
  async (shape) => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    const base = manifest();
    const read: WorkflowStep = {
      id: "read",
      name: "Read",
      type: "operation",
      operation: "connection.crm.echo",
      input: {}
    };
    const definition = shape === "read-only earlier loop" ? before(loop("earlier", [read])) : base;
    if (shape === "read-only earlier loop") {
      definition.limits = { stepRuns: 6 };
      t.setBehaviour(() => Promise.resolve({ clients: [] }));
    }
    if (shape === "non-loop tail") definition.steps.splice(-1, 0, write);
    if (shape === "code prefix")
      definition.steps.splice(2, 0, {
        id: "code",
        name: "Code",
        type: "code",
        file: "read.js",
        input: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "object" }
      });
    const address = { kind: "workflow", name: definition.id };
    const saved = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: {
          name: definition.id,
          manifest: definition,
          ...(shape === "code prefix"
            ? { files: [{ path: "steps/read.js", content: "console.log('{}')" }] }
            : {})
        },
        expectedRevision: null
      }
    });
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: saved.json().revision }
    });
    const tested = await t.expectOk(t.root.id, "workflows.test", {
      params: { workflow: definition.id },
      payload: { input: { note: "Guard" } }
    });
    if (shape === "read-only earlier loop")
      expect(await t.finish(tested.json().id)).toMatchObject({ status: "done" });
  }
);

it("treats an unresolved operation before continuation as unsafe rather than guessing it reads", async () => {
  const issues = await workflowContinuationIssues(before(write));
  expect(issues.find((issue) => issue.path === "steps.before")?.message).toContain(
    "Step 'before' cannot precede"
  );
});
