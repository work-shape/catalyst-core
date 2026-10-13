import { describe, expect, it } from "vitest";
import { checkStartForm, startFormOf, startRefusalByField } from "@vivd-catalyst/chat-ui/workflows";

// The start form of a Workflow: made from the JSON Schema of its published inputs, and the
// check of what a person entered before the instance checks it again.

const inputs = {
  type: "object",
  properties: {
    month: { type: "string", format: "date", title: "Month", description: "The first day." },
    client_id: { type: "string", minLength: 3, maxLength: 8, pattern: "^K[0-9]+$" },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    share: { type: ["number", "null"], exclusiveMinimum: 0, exclusiveMaximum: 1 },
    region: { type: "string", enum: ["north", "south"], default: "south" },
    notify: { type: "boolean" },
    contact: { type: "string", format: "email" }
  },
  required: ["month", "client_id", "region"]
};

describe("the start form of a Workflow", () => {
  it("has one field per input, in the schema's order, with its rules and its default", () => {
    const form = startFormOf(inputs);
    expect(form.unsupported).toEqual([]);
    expect(form.fields).toEqual([
      {
        name: "month",
        label: "Month",
        hint: "The first day.",
        control: "date",
        required: true,
        initial: ""
      },
      {
        name: "client_id",
        label: "Client id",
        control: "text",
        required: true,
        initial: "",
        minLength: 3,
        maxLength: 8,
        pattern: "^K[0-9]+$"
      },
      {
        name: "limit",
        label: "Limit",
        control: "number",
        required: false,
        initial: "10",
        integer: true,
        minimum: 1,
        maximum: 100
      },
      {
        name: "share",
        label: "Share",
        control: "number",
        required: false,
        initial: "",
        exclusiveMinimum: 0,
        exclusiveMaximum: 1
      },
      {
        name: "region",
        label: "Region",
        control: "choice",
        required: true,
        initial: "south",
        options: ["north", "south"]
      },
      { name: "notify", label: "Notify", control: "yesNo", required: false, initial: false },
      { name: "contact", label: "Contact", control: "email", required: false, initial: "" }
    ]);
  });

  it("asks for nothing where the inputs name no property, or are no schema at all", () => {
    for (const none of [undefined, null, "inputs", [], { type: "object" }, { properties: [] }]) {
      expect(startFormOf(none)).toEqual({ fields: [], unsupported: [] });
    }
  });

  it("names the inputs it has no field for, and which of them a start needs", () => {
    const form = startFormOf({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        filter: { type: "object" },
        either: { type: ["string", "number"] },
        mixed: { enum: ["a", 1] },
        broken: "not a schema",
        note: { type: "string", pattern: "([" }
      },
      required: ["ids", 7]
    });
    expect(form.unsupported).toEqual([
      { name: "ids", required: true },
      { name: "filter", required: false },
      { name: "either", required: false },
      { name: "mixed", required: false },
      { name: "broken", required: false }
    ]);
    // A pattern the browser cannot read is the instance's to check, not the form's.
    expect(form.fields).toEqual([
      { name: "note", label: "Note", control: "text", required: false, initial: "" }
    ]);
  });

  it("makes the input of the run from what was entered: numbers as numbers, empty left out", () => {
    const form = startFormOf(inputs);
    expect(
      checkStartForm(form, {
        month: "2026-09-01",
        client_id: "K123",
        limit: "25",
        share: "",
        region: "north",
        notify: true,
        contact: ""
      })
    ).toEqual({
      ok: true,
      input: { month: "2026-09-01", client_id: "K123", limit: 25, region: "north", notify: true }
    });
  });

  it("refuses what the inputs refuse, each field with its own sentence", () => {
    const form = startFormOf(inputs);
    const problems = (values: Record<string, string | boolean>) => {
      const check = checkStartForm(form, values);
      return check.ok ? {} : Object.fromEntries(check.problems);
    };
    expect(problems({})).toEqual({
      month: { key: "workflows.startForm.required" },
      client_id: { key: "workflows.startForm.required" },
      region: { key: "workflows.startForm.choose" }
    });
    const filled = { month: "2026-09-01", client_id: "K123", region: "north" };
    expect(problems({ ...filled, month: "September" })).toEqual({
      month: { key: "workflows.startForm.notDate" }
    });
    expect(problems({ ...filled, client_id: "K1" })).toEqual({
      client_id: { key: "workflows.startForm.tooShort", values: { limit: 3 } }
    });
    expect(problems({ ...filled, client_id: "K123456789" })).toEqual({
      client_id: { key: "workflows.startForm.tooLong", values: { limit: 8 } }
    });
    expect(problems({ ...filled, client_id: "X1234" })).toEqual({
      client_id: { key: "workflows.startForm.notPattern" }
    });
    expect(problems({ ...filled, limit: "2.5" })).toEqual({
      limit: { key: "workflows.startForm.notWhole" }
    });
    expect(problems({ ...filled, limit: "0" })).toEqual({
      limit: { key: "workflows.startForm.atLeast", values: { limit: 1 } }
    });
    expect(problems({ ...filled, limit: "101" })).toEqual({
      limit: { key: "workflows.startForm.atMost", values: { limit: 100 } }
    });
    expect(problems({ ...filled, limit: "ten" })).toEqual({
      limit: { key: "workflows.startForm.notNumber" }
    });
    expect(problems({ ...filled, share: "0" })).toEqual({
      share: { key: "workflows.startForm.moreThan", values: { limit: 0 } }
    });
    expect(problems({ ...filled, share: "1" })).toEqual({
      share: { key: "workflows.startForm.lessThan", values: { limit: 1 } }
    });
    // A value the choice does not hold is refused as an unchosen one.
    expect(problems({ ...filled, region: "west" })).toEqual({
      region: { key: "workflows.startForm.choose" }
    });
    expect(problems({ ...filled, contact: "nobody" })).toEqual({
      contact: { key: "workflows.startForm.notEmail" }
    });
    // Blanks are no value.
    expect(problems({ ...filled, client_id: "   " })).toEqual({
      client_id: { key: "workflows.startForm.required" }
    });
  });

  it("keeps an input named like a property of every object as a field of its own", () => {
    const form = startFormOf(
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}},"required":["__proto__","constructor"]}'
      )
    );
    expect(form.fields.map((field) => field.name)).toEqual(["__proto__", "constructor"]);
    const missing = checkStartForm(form, {});
    expect(missing.ok ? [] : [...missing.problems.keys()]).toEqual(["__proto__", "constructor"]);
    const values: Record<string, string> = Object.fromEntries([
      ["__proto__", "a"],
      ["constructor", "b"]
    ]);
    const check = checkStartForm(form, values);
    expect(check.ok && JSON.stringify(check.input)).toBe('{"__proto__":"a","constructor":"b"}');
    expect(check.ok && Object.getPrototypeOf(check.input)).toBe(Object.prototype);
  });

  it("puts each value the instance refused under its field and keeps the rest for the form", () => {
    const form = startFormOf(inputs);
    const { fields, rest } = startRefusalByField(form, [
      { path: ["limit"], message: "must be <= 100" },
      { path: ["limit"], message: "must be integer" },
      { path: [], message: "must have required property 'month'" },
      { path: ["unknown"], message: "must NOT have additional properties" }
    ]);
    expect(Object.fromEntries(fields)).toEqual({ limit: "must be <= 100" });
    expect(rest).toEqual([
      "must be integer",
      "must have required property 'month'",
      "must NOT have additional properties"
    ]);
  });
});
