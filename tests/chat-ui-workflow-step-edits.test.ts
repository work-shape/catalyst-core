import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  applyStepEdits,
  draftChanges,
  earlierFields,
  editIssues,
  issuePlace,
  rebaseStepEdits,
  withRemovedSteps,
  workflowGraph,
  workflowSteps,
  WORKFLOW_FIELDS,
  type StepEdit
} from "@work-shape/catalyst-chat-ui/workflows";

// Editing a Workflow by hand (WF-EDIT-1, workflow-canvas 9.4 and 9.5): the step operations a
// person makes, carried over to a draft the agent saved meanwhile, and what a draft changes
// against the published revision. Fails without WF-EDIT-1: none of these existed.

const text = createTranslationContext("en");

const published = {
  id: "client-notes",
  name: "Client notes",
  inputs: { type: "object", properties: { region: { type: "string", title: "Region" } } },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "clients",
      name: "Load the clients",
      description: "The clients of one region.",
      type: "operation",
      operation: "crm.list",
      input: { region: { ref: { step: "start", path: "input.region" } } }
    },
    {
      id: "each",
      name: "For each client",
      type: "loop",
      items: { step: "clients", path: "rows" },
      steps: [
        {
          id: "summary",
          name: "Write the summary",
          type: "agent",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { note: { type: "string" } } }
        }
      ]
    },
    {
      id: "notice",
      name: "Tell the office",
      type: "notify",
      to: { users: ["user_1"] },
      channels: ["inbox"],
      title: { value: "Notes are ready" },
      text: { value: "The client notes are written." }
    },
    { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
  ]
};

const set = (step: string, fields: Record<string, unknown>): StepEdit => ({
  kind: "set",
  step,
  fields
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The steps of a list, as records. */
const stepsOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const stepOf = (manifest: Record<string, unknown>, id: string) =>
  JSON.stringify(manifest).includes(`"id":"${id}"`);

describe("applyStepEdits", () => {
  it("sets the fields of a step at any depth and leaves every other step as it was", () => {
    const next = applyStepEdits(published, [
      set("summary", { name: "Write the note", description: "One note per client." }),
      set("notice", { title: { value: "Done" } })
    ]);
    const loop = stepsOf(next.steps)[2];
    expect(stepsOf(loop?.steps)[0]).toMatchObject({
      id: "summary",
      name: "Write the note",
      description: "One note per client."
    });
    expect(stepsOf(next.steps)[3]).toMatchObject({
      title: { value: "Done" }
    });
    expect(stepsOf(next.steps)[1]).toEqual(published.steps[1]);
    // The manifest given is not changed.
    expect(published.steps[3]).toMatchObject({ title: { value: "Notes are ready" } });
  });

  it("takes a field away for undefined, never changes an id or a type, and sets the Workflow's own fields", () => {
    const next = applyStepEdits(published, [
      set("notice", { link: { kind: "run" } }),
      set("notice", { link: undefined, id: "other", type: "agent" }),
      set(WORKFLOW_FIELDS, { outputs: { type: "object" }, id: "renamed", steps: [] })
    ]);
    const notice = stepsOf(next.steps)[3] ?? {};
    expect(notice).not.toHaveProperty("link");
    expect(notice).toMatchObject({ id: "notice", type: "notify" });
    expect(next).toMatchObject({ id: "client-notes", outputs: { type: "object" } });
    expect(next.steps).toHaveLength(5);
  });

  it("does nothing for a step the manifest does not hold", () => {
    expect(applyStepEdits(published, [set("gone", { name: "x" })])).toEqual(published);
  });
});

describe("rebaseStepEdits: a save after the agent saved meanwhile (decision 6)", () => {
  const edits = [set("notice", { title: { value: "The notes are ready" } })];

  it("carries the edits over without a question where the agent changed another step", () => {
    const latest = applyStepEdits(published, [set("clients", { name: "Load every client" })]);
    const rebased = rebaseStepEdits({ base: published, latest, edits });
    expect(rebased).toEqual({ edits, conflicts: [], dropped: [] });
    // Both changes are in what is saved.
    const saved = applyStepEdits(latest, rebased.edits);
    expect(JSON.stringify(saved)).toContain("Load every client");
    expect(JSON.stringify(saved)).toContain("The notes are ready");
  });

  it("keeps the person's value and names the agent's where the agent changed the same field", () => {
    const latest = applyStepEdits(published, [set("notice", { title: { value: "Agent title" } })]);
    const rebased = rebaseStepEdits({ base: published, latest, edits });
    expect(rebased.edits).toEqual(edits);
    expect(rebased.conflicts).toEqual([
      { step: "notice", field: "title", theirs: { value: "Agent title" } }
    ]);
    expect(rebased.dropped).toEqual([]);
  });

  it("names no conflict where the agent set the same value the person did", () => {
    const latest = applyStepEdits(published, edits);
    expect(rebaseStepEdits({ base: published, latest, edits }).conflicts).toEqual([]);
  });

  it("drops the edits of a step the agent deleted", () => {
    const latest = {
      ...published,
      steps: published.steps.filter((step) => step.id !== "notice")
    };
    const rebased = rebaseStepEdits({ base: published, latest, edits });
    expect(rebased).toEqual({ edits: [], conflicts: [], dropped: ["notice"] });
    expect(stepOf(applyStepEdits(latest, rebased.edits), "notice")).toBe(false);
  });
});

describe("draftChanges: what a draft changes against the published revision (9.5)", () => {
  it("says nothing of a Workflow never published", () => {
    const changes = draftChanges(undefined, published);
    expect(changes.steps.size).toBe(0);
    expect(changes.removed).toEqual([]);
  });

  it("names new, changed, removed and moved steps, and the fields that changed", () => {
    const steps = published.steps;
    const draft = {
      ...published,
      steps: [
        steps[0],
        // Moved: the notice now comes before the clients are loaded.
        steps[3],
        { ...steps[1], name: "Load every client" },
        { id: "extra", name: "Look up the region", type: "agent" },
        // The loop is gone, with its step.
        steps[4]
      ]
    };
    const changes = draftChanges(published, draft);
    expect(Object.fromEntries(changes.steps)).toMatchObject({
      clients: "changed",
      extra: "new",
      each: "removed",
      summary: "removed"
    });
    expect(changes.fields.get("clients")).toEqual(["name"]);
    // Of two steps that swapped places, one is the one that moved.
    const moved = draftChanges(published, {
      ...published,
      steps: [steps[0], steps[3], steps[1], steps[2], steps[4]]
    });
    expect([...moved.steps.keys()]).toHaveLength(1);
    expect(["notice", "clients", "each"]).toContain([...moved.steps.keys()][0]);
    expect(moved.fields.size).toBe(0);
    // Only the block is drawn back; its step goes with it.
    expect(changes.removed).toEqual([{ id: "each", list: "", after: "clients" }]);
  });

  it("marks a step that moved into a block as changed, and none that only shifted", () => {
    const steps = published.steps;
    const loop = steps[2];
    const draft = {
      ...published,
      steps: [steps[0], steps[1], { ...loop, steps: [...stepsOf(loop?.steps), steps[3]] }, steps[4]]
    };
    expect(Object.fromEntries(draftChanges(published, draft).steps)).toEqual({ notice: "changed" });
  });

  it("puts a removed step back where it stood, after the step before it", () => {
    const draft = { ...published, steps: published.steps.filter((step) => step.id !== "notice") };
    const changes = draftChanges(published, draft);
    const drawn = withRemovedSteps(workflowSteps(draft), workflowSteps(published), changes.removed);
    expect(drawn.map((step) => step.id)).toEqual(["start", "clients", "each", "notice", "result"]);
  });

  it("is drawn on the canvas as a mark with the published sentence struck through", () => {
    const draft = applyStepEdits(published, [
      set("clients", { description: "Every client of the region." })
    ]);
    const was = workflowSteps(published).find((step) => step.id === "clients");
    const graph = workflowGraph(
      workflowSteps(draft),
      text,
      undefined,
      undefined,
      undefined,
      new Map([
        ["clients", { change: "changed" as const, ...(was === undefined ? {} : { was }) }],
        ["notice", { change: "unsaved" as const }]
      ])
    );
    const node = (id: string) => graph.nodes.find((candidate) => candidate.id === id);
    expect(node("clients")).toMatchObject({
      change: "changed",
      summary: "Every client of the region."
    });
    expect(node("clients")?.oldSummary).toBe("The clients of one region.");
    expect(node("notice")?.change).toBe("unsaved");
    expect(node("start")?.change).toBeUndefined();
  });
});

describe("the fields of earlier results a step may take", () => {
  const words = { entry: (loop: string) => `Each entry of ${loop}`, input: "Run input" };

  it("offers what the run was started with and each earlier step's result, nearest first", () => {
    const facts = {
      clients: {
        outputSchema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: { type: "object", properties: { name: { type: "string" } } }
            },
            count: { type: "integer", title: "How many" }
          }
        }
      }
    };
    expect(earlierFields(published, "notice", facts, words)).toEqual([
      {
        heading: "Load the clients",
        options: [
          { value: "clients#rows", label: "rows" },
          { value: "clients#count", label: "How many" }
        ]
      },
      { heading: "Run input", options: [{ value: "start#input.region", label: "Region" }] }
    ]);
    // A loop offers the lists alone; a step inside it the fields of its entry.
    expect(earlierFields(published, "each", facts, words, { lists: true })).toEqual([
      { heading: "Load the clients", options: [{ value: "clients#rows", label: "rows" }] }
    ]);
    expect(earlierFields(published, "summary", facts, words)[0]).toEqual({
      heading: "Each entry of For each client",
      options: [{ value: "each#name", label: "name" }]
    });
  });
});

describe("what the instance refuses, under the field it names", () => {
  it("reads a place by step id as the definition names it, and by position as the schema does", () => {
    expect(issuePlace(["steps.notice.title"], published)).toEqual({
      step: "notice",
      field: "title"
    });
    expect(issuePlace(["manifest", "steps", "1", "name"], published)).toEqual({
      step: "clients",
      field: "name"
    });
    expect(issuePlace(["steps.result.input.done"], published)).toEqual({
      step: "result",
      field: "input",
      name: "done"
    });
    expect(issuePlace(["steps.2.steps.0.name"], published)).toEqual({
      step: "summary",
      field: "name"
    });
    expect(issuePlace(["steps"], published)).toBeUndefined();
    expect(issuePlace(["steps.gone.name"], published)).toBeUndefined();
  });

  it("keeps an issue that names no field apart", () => {
    const issues = editIssues(
      [
        { message: "A step reads a later step", path: ["steps.notice.text"] },
        { message: "The one output step is the last step", path: ["steps"] }
      ],
      published
    );
    expect(issues.fields.get("notice:text")).toBe("A step reads a later step");
    expect(issues.other).toEqual(["The one output step is the last step"]);
  });
});
