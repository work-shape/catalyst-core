import { describe, expect, it } from "vitest";
import {
  applyFileEdits,
  applyStepEdits,
  draftValueOf,
  mappingOf,
  rowsOf,
  fieldListProblems,
  fieldsSchema,
  pickedSchema,
  rebaseStepEdits,
  schemaFields,
  SCRIPT_FIELD,
  stepValue,
  withKeys
} from "@work-shape/catalyst-chat-ui/workflows";

// What an AI step or a script answers with, as the Settings tab edits it (WF-EDIT-2): a list
// of fields in the subset of JSON Schema every model binding takes, read from a schema and
// written back to the same schema; the schema of a value picked from an earlier result; and a
// script edited as a field of its step. Fails without WF-EDIT-2: none of these existed.

const every = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One line." },
    score: { type: "number" },
    count: { type: "integer", title: "How many" },
    urgent: { type: "boolean" },
    status: { type: "string", enum: ["open", "done"] },
    tags: { type: "array", items: { type: "string" } },
    client: {
      type: "object",
      properties: { name: { type: "string" }, since: { type: "integer" } },
      required: ["name"]
    },
    lines: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    }
  },
  required: ["summary", "status"]
};

describe("schemaFields and fieldsSchema", () => {
  it("read every kind of field and write the same schema back", () => {
    const fields = schemaFields(every);
    expect(fields?.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["summary", "text", true],
      ["score", "number", false],
      ["count", "integer", false],
      ["urgent", "boolean", false],
      ["status", "choice", true],
      ["tags", "list", false],
      ["client", "record", false],
      ["lines", "records", false]
    ]);
    expect(fields?.[4]?.choices).toEqual(["open", "done"]);
    expect(fields?.[6]?.fields?.map((field) => [field.name, field.required])).toEqual([
      ["name", true],
      ["since", false]
    ]);
    expect(fieldsSchema(fields ?? [], every)).toEqual(every);
  });

  it("make an answer of no fields from no schema, and leave out a field with no name", () => {
    expect(schemaFields(undefined)).toEqual([]);
    expect(
      fieldsSchema([
        { id: "a", name: "summary", kind: "text", required: true },
        { id: "b", name: " ", kind: "number", required: false }
      ])
    ).toEqual({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"]
    });
  });

  it("refuse a schema outside the subset: a field that nests a record in a record, or a reference", () => {
    const nested = {
      type: "object",
      properties: {
        client: {
          type: "object",
          properties: { address: { type: "object", properties: { city: { type: "string" } } } }
        }
      }
    };
    expect(schemaFields(nested)).toBeUndefined();
    expect(schemaFields({ type: "object", properties: { next: { $ref: "#" } } })).toBeUndefined();
    expect(
      schemaFields({ type: "object", properties: { either: { anyOf: [{ type: "string" }] } } })
    ).toBeUndefined();
    expect(schemaFields({ type: "array", items: { type: "string" } })).toBeUndefined();
  });

  it("name what holds the save back: a field with no title, a key twice, a choice with none", () => {
    expect(
      fieldListProblems([
        { id: "a", name: "", title: " ", kind: "text", required: false },
        { id: "b", name: "x", title: "X", kind: "text", required: false },
        { id: "c", name: "x", title: "Y", kind: "choice", required: false, choices: [" "] }
      ])
    ).toEqual({ a: { title: "missing" }, c: { name: "taken", choices: "missing" } });
  });
});

// A person names a field by its title; its key is what later steps and the start form read
// (WF-EDIT-5c). Fails without WF-EDIT-5c: a field had only a name, which was its key.
describe("the title and the key of a field", () => {
  const saved = {
    type: "object",
    properties: {
      month: { type: "string", title: "Month" },
      client: { type: "object", properties: { name: { type: "string" } } }
    }
  };

  it("reads a field's title, or its key where it has none", () => {
    expect(schemaFields(saved)?.map((field) => [field.name, field.title])).toEqual([
      ["month", "Month"],
      ["client", "client"]
    ]);
  });

  it("gives a new field a key from its title as a step id is made, and follows the title", () => {
    const fresh = { id: "new", name: "", kind: "text", required: false };
    expect(withKeys([{ ...fresh, title: "Monat" }], undefined)[0]?.name).toBe("monat");
    expect(
      withKeys([{ ...fresh, name: "monat", title: "Größe des Büros" }], undefined)[0]?.name
    ).toBe("groesse_des_bueros");
    expect(withKeys([{ ...fresh, title: "" }], undefined)[0]?.name).toBe("");
    expect(withKeys([{ ...fresh, title: "2026" }], undefined)[0]?.name).toBe("field");
  });

  it("keeps the key of a saved field when its title changes, and makes a new key unique", () => {
    const fields = schemaFields(saved) ?? [];
    const renamed = fields.map((field) =>
      field.name === "month" ? { ...field, title: "Billing month" } : field
    );
    const keyed = withKeys(
      [...renamed, { id: "new", name: "", title: "Month", kind: "text", required: false }],
      saved
    );
    expect(keyed.map((field) => field.name)).toEqual(["month", "client", "month_2"]);
    expect(fieldsSchema(keyed, saved).properties).toEqual({
      month: { type: "string", title: "Billing month" },
      client: { type: "object", properties: { name: { type: "string" } } },
      month_2: { type: "string", title: "Month" }
    });
  });

  it("keeps the keys of a saved record's fields, and derives those of a new one", () => {
    const [, client] = schemaFields(saved) ?? [];
    if (client === undefined) throw new Error("no client field");
    const keyed = withKeys(
      [
        {
          ...client,
          fields: [
            ...(client.fields ?? []).map((field) => ({ ...field, title: "Full name" })),
            { id: "since", name: "", title: "Client since", kind: "integer", required: false }
          ]
        }
      ],
      saved
    );
    expect(keyed[0]?.fields?.map((field) => field.name)).toEqual(["name", "client_since"]);
  });
});

const manifest = {
  id: "notes",
  name: "Notes",
  inputs: { type: "object", properties: { region: { type: "string", title: "Region" } } },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "clients",
      name: "Load the clients",
      type: "operation",
      operation: "crm.list",
      input: {}
    },
    {
      id: "each",
      name: "For each client",
      type: "loop",
      items: { step: "clients", path: "rows" },
      steps: [{ id: "compute", name: "Count", type: "code", file: "compute.py", input: {} }]
    }
  ]
};
const facts = {
  clients: {
    outputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "object", properties: { since: { type: "integer", title: "Since" } } }
        }
      }
    }
  }
};

describe("the schema of a value picked from an earlier result", () => {
  it("is the field's schema in what the run was started with, a result or a loop's entry", () => {
    expect(pickedSchema(manifest, facts, { step: "start", path: "input.region" })).toEqual({
      type: "string",
      title: "Region"
    });
    expect(pickedSchema(manifest, facts, { step: "clients", path: "rows" })).toMatchObject({
      type: "array"
    });
    expect(pickedSchema(manifest, facts, { step: "each", path: "since" })).toEqual({
      type: "integer",
      title: "Since"
    });
    expect(pickedSchema(manifest, facts, { step: "clients", path: "gone" })).toBeUndefined();
  });
});

describe("a value to be picked from a step whose field is not chosen yet", () => {
  it("stays a pick in the form and holds the save back", () => {
    // Switching a value to "From a step" made it fixed again: the form kept no empty pick.
    const pending = draftValueOf({ kind: "picked", option: "" });
    expect(pending).toEqual({ ref: { step: "", path: "" } });
    const rows = rowsOf({ count: pending });
    expect(rows).toEqual([{ name: "count", value: { kind: "picked", option: "" } }]);
    expect(mappingOf(rows ?? [])).toBeUndefined();
    expect(draftValueOf({ kind: "picked", option: "clients#rows" })).toEqual({
      ref: { step: "clients", path: "rows" }
    });
  });
});

describe("a script edited as a field of its step", () => {
  const files = [{ path: "steps/compute.py", content: "print(1)" }];
  const edit = { kind: "set" as const, step: "compute", fields: { [SCRIPT_FIELD]: "print(2)" } };

  it("is written to the step's file and never into the manifest", () => {
    expect(applyStepEdits(manifest, [edit])).toEqual(manifest);
    expect(applyFileEdits(manifest, files, [edit])).toEqual([
      { path: "steps/compute.py", content: "print(2)" }
    ]);
    expect(applyFileEdits(manifest, [], [edit])).toEqual([
      { path: "steps/compute.py", content: "print(2)" }
    ]);
    expect(stepValue(manifest, files, "compute", SCRIPT_FIELD)).toBe("print(1)");
  });

  it("names the agent's script where the agent changed it meanwhile", () => {
    const latestFiles = [{ path: "steps/compute.py", content: "print(3)" }];
    expect(
      rebaseStepEdits({
        base: manifest,
        latest: manifest,
        edits: [edit],
        baseFiles: files,
        latestFiles
      }).conflicts
    ).toEqual([{ step: "compute", field: SCRIPT_FIELD, theirs: "print(3)" }]);
    expect(
      rebaseStepEdits({
        base: manifest,
        latest: manifest,
        edits: [edit],
        baseFiles: files,
        latestFiles: files
      }).conflicts
    ).toEqual([]);
  });
});
