import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { required } from "./support/assertions";
import {
  applyStepEdits,
  editPlaces,
  heldIds,
  moveRefusal,
  newStepOf,
  paletteGroups,
  readersOf,
  rebaseStepEdits,
  stepIdFrom,
  stepPlaceOf,
  workflowGraph,
  workflowSteps,
  type CallableOperationOption,
  type StepEdit
} from "@work-shape/catalyst-chat-ui/workflows";

// Adding, deleting and moving steps by hand (WF-EDIT-4, workflow-canvas 9.6, Events check
// 127): where a new step goes for each place of the canvas, the id it takes from its name,
// which steps stop a delete, and that a block moves with what it holds. Fails without WF-EDIT-4:
// a step could only be changed, never added, deleted or moved.

const text = createTranslationContext("en");

type Manifest = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const idsOf = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter(isRecord).map((step) => String(step.id)) : [];
const listOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
const stepIn = (manifest: Manifest, id: string): Record<string, unknown> => {
  const found = listOf(manifest.steps).find((step) => step.id === id);
  if (found === undefined) throw new Error(`No top-level step ${id}`);
  return found;
};

const draft: Manifest = {
  id: "client-notes",
  name: "Client notes",
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "clients", name: "Load the clients", type: "operation", operation: "crm.list" },
    {
      id: "each",
      name: "For each client",
      type: "loop",
      items: { step: "clients", path: "rows" },
      steps: [
        { id: "summary", name: "Write the summary", type: "operation", operation: "notes.write" },
        { id: "file", name: "File the summary", type: "operation", operation: "notes.file" }
      ]
    },
    {
      id: "check",
      name: "Any notes?",
      type: "condition",
      if: { value: true },
      then: [{ id: "notice", name: "Tell the office", type: "operation", operation: "mail.send" }],
      else: []
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { notes: { ref: { step: "clients", path: "rows" } } }
    }
  ]
};

const fields = { name: "Check the address", type: "operation", operation: "crm.check" };

describe("where a new step goes (9.6)", () => {
  it("puts a step on an edge after the step the edge leaves", () => {
    const at = stepPlaceOf({ kind: "edge", source: "clients", target: "each" });
    const next = applyStepEdits(draft, [{ kind: "insert", step: "address", at, fields }]);
    expect(idsOf(next.steps)).toEqual(["start", "clients", "address", "each", "check", "result"]);
  });

  it("puts a step on a condition's path first on that path, and at a loop's end last in it", () => {
    const onPath = stepPlaceOf({ kind: "exit", nodeId: "check", exitId: "else" });
    const atEnd = stepPlaceOf({ kind: "end", groupId: "each" });
    const next = applyStepEdits(draft, [
      { kind: "insert", step: "address", at: onPath, fields },
      { kind: "insert", step: "archive", at: atEnd, fields: { ...fields, name: "Archive" } }
    ]);
    expect(idsOf(stepIn(next, "check").else)).toEqual(["address"]);
    expect(idsOf(stepIn(next, "each").steps)).toEqual(["summary", "file", "archive"]);
  });

  it("puts nothing where the draft no longer holds the place", () => {
    const at = stepPlaceOf({ kind: "edge", source: "gone", target: "each" });
    expect(applyStepEdits(draft, [{ kind: "insert", step: "address", at, fields }])).toBe(draft);
  });
});

describe("the id of a new step (decision 7)", () => {
  it("is spelled from the name in letters a step id takes", () => {
    expect(stepIdFrom("Prüfe die Adresse", new Set())).toBe("pruefe_die_adresse");
    expect(stepIdFrom("Größe & Maß", new Set())).toBe("groesse_mass");
    expect(stepIdFrom("Café crème", new Set())).toBe("cafe_creme");
    expect(stepIdFrom("2. Mail senden", new Set())).toBe("mail_senden");
    expect(stepIdFrom("!!!", new Set())).toBe("step");
    expect(stepIdFrom("x".repeat(80), new Set())).toHaveLength(56);
  });

  it("is never one the Workflow has", () => {
    expect(stepIdFrom("Load the clients", new Set(["load_the_clients"]))).toBe(
      "load_the_clients_2"
    );
    expect(
      stepIdFrom("Load the clients", new Set(["load_the_clients", "load_the_clients_2"]))
    ).toBe("load_the_clients_3");
  });

  it("stays when the step is renamed", () => {
    const at = stepPlaceOf({ kind: "edge", source: "clients", target: "each" });
    const next = applyStepEdits(draft, [
      { kind: "insert", step: "check_the_address", at, fields },
      { kind: "set", step: "check_the_address", fields: { name: "Prüfe die Adresse" } }
    ]);
    expect(stepIn(next, "check_the_address").name).toBe("Prüfe die Adresse");
  });
});

describe("deleting a step (9.6)", () => {
  it("names the steps that read its result, and none that goes with it", () => {
    expect(readersOf(draft, "clients").map((step) => step.id)).toEqual(["each", "result"]);
    // The loop reads `clients`, not itself; nothing outside reads what it holds.
    expect(readersOf(draft, "each")).toEqual([]);
    expect(readersOf(draft, "summary")).toEqual([]);
  });

  it("takes a block away with what it holds", () => {
    expect(heldIds(stepIn(draft, "each"))).toEqual(["each", "summary", "file"]);
    const next = applyStepEdits(draft, [{ kind: "delete", step: "each" }]);
    expect(idsOf(next.steps)).toEqual(["start", "clients", "check", "result"]);
    expect(JSON.stringify(next)).not.toContain("summary");
  });
});

describe("moving a step (9.6)", () => {
  it("moves a loop with the steps it holds", () => {
    const at = stepPlaceOf({ kind: "exit", nodeId: "check", exitId: "then" });
    const next = applyStepEdits(draft, [{ kind: "move", step: "each", at }]);
    expect(idsOf(next.steps)).toEqual(["start", "clients", "check", "result"]);
    const then = listOf(stepIn(next, "check").then)[0];
    expect(then?.id).toBe("each");
    expect(idsOf(then?.steps)).toEqual(["summary", "file"]);
  });

  it("never moves a block into itself", () => {
    const at = stepPlaceOf({ kind: "edge", source: "summary", target: "file" });
    expect(applyStepEdits(draft, [{ kind: "move", step: "each", at }])).toBe(draft);
  });

  it("drops an add or a move whose place the agent deleted meanwhile", () => {
    const latest = applyStepEdits(draft, [{ kind: "delete", step: "check" }]);
    const edits: StepEdit[] = [
      {
        kind: "insert",
        step: "address",
        at: { kind: "first", block: "check", path: "then" },
        fields
      },
      { kind: "move", step: "file", at: { kind: "after", step: "notice" } },
      { kind: "move", step: "summary", at: { kind: "after", step: "clients" } }
    ];
    const rebased = rebaseStepEdits({ base: draft, latest, edits });
    expect(rebased.dropped).toEqual(["address", "file"]);
    expect(rebased.edits).toEqual([edits[2]]);
  });
});

describe("the places the canvas offers", () => {
  const graph = workflowGraph(workflowSteps(draft), text);
  const places = (moving?: string) => editPlaces(graph, draft, moving, text.t);

  it("names each place by the step, path or block it stands at", () => {
    expect(places().words({ kind: "edge", source: "clients", target: "each" }, true)).toBe(
      "Add a step after “Load the clients”"
    );
    expect(places().words({ kind: "end", groupId: "each" }, false)).toBe(
      "at the end of “For each client”"
    );
    expect(places().words({ kind: "exit", nodeId: "check", exitId: "else" }, true)).toMatch(
      /^Add a step on the path “.+”$/u
    );
  });

  it("offers no place beside or inside the step that moves", () => {
    const { shows } = places("each");
    expect(shows?.({ kind: "edge", source: "clients", target: "each" })).toBe(false);
    expect(shows?.({ kind: "edge", source: "each", target: "check" })).toBe(false);
    expect(shows?.({ kind: "edge", source: "summary", target: "file" })).toBe(false);
    expect(shows?.({ kind: "end", groupId: "each" })).toBe(false);
    expect(shows?.({ kind: "exit", nodeId: "check", exitId: "then" })).toBe(true);
    expect(places().shows?.({ kind: "end", groupId: "each" })).toBe(true);
  });
});

describe("the palette (9.6)", () => {
  const operations: CallableOperationOption[] = [
    {
      name: "crm.list",
      title: "List the clients",
      effect: "reading",
      source: { kind: "connection", title: "CRM" },
      available: true
    },
    {
      name: "mail.send",
      title: "Send mail",
      effect: "changing",
      source: { kind: "other" },
      available: true
    }
  ];

  it("offers the step types this release runs, grouped, and no trigger, result, If or parallel block", () => {
    const groups = paletteGroups(operations, text.t);
    expect(groups.map((group) => group.heading)).toEqual([
      "Data and systems",
      "AI and code",
      "Flow",
      "People"
    ]);
    const values = groups.flatMap((group) => group.options.map((option) => option.value));
    expect(values).toEqual([
      "operation:crm.list",
      "agent",
      "python",
      "javascript",
      "loop",
      "workflow",
      "notify",
      "operation:mail.send"
    ]);
    expect(groups[3]?.options.map((option) => option.label)).toEqual([
      "Send a message",
      "Send an e-mail"
    ]);
  });

  it("makes a new step a type the definition takes, named by the entry", () => {
    const script = required(newStepOf("python", operations, text.t));
    expect(script.name).toBe("Script in Python");
    expect(script.fields("pruefe_adresse")).toMatchObject({
      type: "code",
      file: "pruefe_adresse.py"
    });
    const listing = required(newStepOf("operation:crm.list", operations, text.t));
    expect(listing.fields("list_the_clients")).toEqual({
      type: "operation",
      name: "List the clients",
      operation: "crm.list",
      input: {}
    });
    expect(newStepOf("condition", operations, text.t)).toBeUndefined();
  });
});

describe("a move the instance refuses", () => {
  it("says which step would no longer see the result it reads, by name", () => {
    const moved = applyStepEdits(draft, [
      { kind: "move", step: "clients", at: { kind: "after", step: "each" } }
    ]);
    const issue = (step: string) => ({
      code: "reference_out_of_scope",
      path: ["manifest", "steps", step],
      message: `Step '${step}' references step 'clients', which it does not see from its place`
    });
    expect(moveRefusal([issue("each"), issue("each")], moved, "clients", text.t)).toBe(
      "“For each client” reads the result of “Load the clients” and would not see it there."
    );
    expect(moveRefusal([issue("clients")], moved, "clients", text.t)).toBe(
      "“Load the clients” reads the result of a step it would not see there."
    );
    expect(
      moveRefusal([{ path: [], message: "The definition is too large." }], moved, "clients", text.t)
    ).toBe("The definition is too large.");
  });
});
