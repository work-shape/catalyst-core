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
function loop(
  id: string,
  steps: WorkflowStep[],
  continues = false
): Extract<WorkflowStep, { type: "loop" }> {
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
function concurrentAncestor(depth: number, continues: boolean): WorkflowManifest {
  const base = manifest();
  let inner = loop("inner", [{ ...write, id: "pair" }], true);
  for (let level = 1; level < depth; level++) inner = loop(`middle_${level}`, [inner]);
  base.steps.splice(2, 1, {
    ...loop(
      "each_client",
      [inner, { ...write, id: "after_inner" }, { ...write, id: "outer_tail" }],
      continues
    ),
    concurrency: 3
  });
  return base;
}
const refused = [
  ...[
    [1, false],
    [2, true],
    [3, false]
  ].map(([depth, continues]) => ({
    name: `concurrent ancestor at depth ${String(depth)}, continuing=${String(continues)}`,
    make: () => concurrentAncestor(Number(depth), Boolean(continues)),
    step: "each_client",
    rule: "cannot use concurrency above 1 while enclosing continueAsNew loop 'inner'"
  })),
  {
    name: "loop A then plain loop B",
    make: () => after(false),
    step: "later",
    rule: "cannot follow"
  },
  {
    name: "two continueAsNew loops",
    make: () => after(true),
    step: "later",
    rule: "cannot follow"
  },
  { name: "write before", make: () => before(write), step: "before", rule: "cannot precede" },
  { name: "notify before", make: () => before(notify), step: "notice", rule: "cannot precede" },
  { name: "child start before", make: () => before(child), step: "child", rule: "cannot precede" },
  {
    name: "loop containing a write before",
    make: () => before(loop("earlier", [write])),
    step: "earlier",
    rule: "cannot precede"
  },
  {
    name: "write at enclosing level",
    make: () => enclosing(write),
    step: "before",
    rule: "cannot precede"
  },
  {
    name: "loop after continuation at enclosing level",
    make: () => enclosing(loop("later", [write]), true),
    step: "later",
    rule: "cannot follow"
  },
  {
    name: "flat loop at stepRuns 4",
    make: () => ({ ...manifest(), limits: { stepRuns: 4 } }),
    step: "each_client",
    rule: "needs at least 5 step runs"
  }
];

/** Saves the definition under its own name and asks a publish of it. */
async function publishAs(t: WorkflowFixture, name: string, definition: WorkflowManifest) {
  const address = { kind: "workflow", name };
  const saved = await t.expectOk(t.admin.id, "assets.put", {
    params: address,
    payload: { config: { name, manifest: { ...definition, id: name } }, expectedRevision: null }
  });
  return t.call(t.root.id, "assets.publish", {
    params: address,
    payload: { revision: saved.json().revision }
  });
}

it("refuses unsafe continuation shapes at publish and before opening a draft test run", async () => {
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets" }
  );
  const childDefinition = {
    ...manifest(),
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
  } satisfies WorkflowManifest;
  expect((await publishAs(t, "another", childDefinition)).statusCode).toBe(200);
  for (const [index, { name, make, step, rule }] of refused.entries()) {
    const id = `guard-${String(index)}`;
    const published = await publishAs(t, id, make());
    const tested = await t.call(t.root.id, "workflows.test", {
      params: { workflow: id },
      payload: { input: { note: "Guard" } }
    });
    for (const response of [published, tested]) {
      expect(response.statusCode, `${name}: ${response.body}`).toBe(422);
      expect(response.json().error.message, name).toContain(`'${step}'`);
      expect(response.json().error.message, name).toContain(rule);
    }
  }
});

it("publishes and tests a continuation as the last loop after a read-only loop, a code step or before a plain tail", async () => {
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets" }
  );
  t.setBehaviour(() => Promise.resolve({ clients: [] }));
  const read: WorkflowStep = {
    id: "read",
    name: "Read",
    type: "operation",
    operation: "connection.crm.echo",
    input: {}
  };
  const readOnlyLoop = { ...before(loop("earlier", [read])), limits: { stepRuns: 6 } };
  const tail = manifest();
  tail.steps.splice(-1, 0, write);
  const code = manifest();
  code.steps.splice(2, 0, {
    id: "code",
    name: "Code",
    type: "code",
    file: "read.js",
    input: {},
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  });
  for (const [name, definition, files] of [
    ["read-only-loop", readOnlyLoop, undefined],
    ["plain-tail", tail, undefined],
    ["code-prefix", code, [{ path: "steps/read.js", content: "console.log('{}')" }]]
  ] as const) {
    const address = { kind: "workflow", name };
    const saved = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: { name, manifest: { ...definition, id: name }, ...(files ? { files } : {}) },
        expectedRevision: null
      }
    });
    await t.expectOk(t.root.id, "assets.publish", {
      params: address,
      payload: { revision: saved.json().revision }
    });
    const tested = await t.expectOk(t.root.id, "workflows.test", {
      params: { workflow: name },
      payload: { input: { note: "Guard" } }
    });
    if (name === "read-only-loop")
      expect(await t.finish(tested.json().id)).toMatchObject({ status: "done" });
  }
});

it("treats an unresolved operation before continuation as unsafe rather than guessing it reads", async () => {
  const issues = await workflowContinuationIssues(before(write));
  expect(issues.find((issue) => issue.path === "steps.before")?.message).toContain(
    "Step 'before' cannot precede"
  );
});

it("names the carrying loop and its path when an inner loop exceeds the budget floor", async () => {
  const definition = manifest();
  definition.limits = { stepRuns: 5 };
  definition.steps.splice(2, 1, loop("each_client", [loop("inner", [write])], true));
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets" }
  );
  const params = { kind: "workflow", name: definition.id };
  const saved = await t.expectOk(t.admin.id, "assets.put", {
    params,
    payload: { config: { name: definition.id, manifest: definition }, expectedRevision: null }
  });
  const response = await t.call(t.root.id, "assets.publish", {
    params,
    payload: { revision: saved.json().revision }
  });
  expect(response.statusCode).toBe(422);
  expect(response.json().error.details.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: "steps.each_client.continueAsNew" })])
  );
  expect(response.json().error.message).toContain("The loop 'each_client' needs at least 6");
  expect(response.json().error.message).not.toContain("The loop 'inner'");
});

it("accepts branch frontiers and refuses replayed top-level branch writes", async () => {
  const wrap = (steps: readonly WorkflowStep[]): WorkflowStep => ({
    id: "fork",
    name: "Fork",
    type: "parallel",
    branches: [{ id: "one", name: "One", steps }]
  });
  const base = manifest();
  const continuing = base.steps[2];
  if (!continuing || continuing.type !== "loop") throw new Error("Expected continuing loop");
  const inBranch = {
    ...base,
    steps: [...base.steps.slice(0, 2), wrap([continuing]), ...base.steps.slice(3)]
  };
  expect(
    (await workflowContinuationIssues(inBranch)).filter((issue) =>
      issue.path.endsWith("continueAsNew")
    )
  ).toEqual([]);
  const inLoop = {
    ...base,
    steps: [
      ...base.steps.slice(0, 2),
      { ...continuing, steps: [wrap([write])] },
      ...base.steps.slice(3)
    ]
  };
  expect(
    (await workflowContinuationIssues(inLoop)).filter((issue) =>
      issue.path.endsWith("continueAsNew")
    )
  ).toEqual([]);
  expect(await workflowContinuationIssues(before(wrap([write])))).toContainEqual(
    expect.objectContaining({
      path: "steps.fork",
      message: expect.stringContaining("would run again")
    })
  );
});
