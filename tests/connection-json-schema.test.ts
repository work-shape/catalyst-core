import { describe, expect, it, vi } from "vitest";
import {
  JSON_SCHEMA_CACHE_MAX_ENTRIES,
  JSON_SCHEMA_MAX_BYTES,
  JSON_SCHEMA_MAX_DEPTH,
  JSON_SCHEMA_MAX_NODES,
  compileJsonSchema,
  isJsonSchemaWithinBounds,
  jsonSchemaAsZod
} from "@work-shape/catalyst-connections";
import type { JsonObject, JsonValue } from "@work-shape/catalyst-core";

// The JSON Schema an outside system may have written: what is compiled at all and what
// compiling one leaves behind.

/** `levels` objects, one inside the other. */
function nested(levels: number): JsonObject {
  let schema: JsonObject = { type: "string" };
  for (let level = 1; level < levels; level += 1) {
    schema = { not: schema };
  }
  return schema;
}

describe("the bounds of a schema", () => {
  // Fails without the change: each of these was compiled, whatever its size, and the last
  // one threw a RangeError out of `compileJsonSchema`.
  it("refuses a schema over the bytes, the depth or the node count this file allows", () => {
    expect(compileJsonSchema(nested(JSON_SCHEMA_MAX_DEPTH)).ok).toBe(true);
    expect(compileJsonSchema(nested(JSON_SCHEMA_MAX_DEPTH + 1))).toEqual({ ok: false });

    const describedIn = (bytes: number): JsonObject => ({
      type: "string",
      description: "x".repeat(bytes)
    });
    expect(compileJsonSchema(describedIn(JSON_SCHEMA_MAX_BYTES - 100)).ok).toBe(true);
    expect(compileJsonSchema(describedIn(JSON_SCHEMA_MAX_BYTES))).toEqual({ ok: false });
    // Bytes, not characters.
    expect(
      compileJsonSchema({ type: "string", description: "ä".repeat(JSON_SCHEMA_MAX_BYTES / 2) })
    ).toEqual({ ok: false });

    const listing = (values: number): JsonObject => ({
      enum: Array.from({ length: values }, (_unused, index) => index)
    });
    expect(compileJsonSchema(listing(1_000)).ok).toBe(true);
    expect(compileJsonSchema(listing(JSON_SCHEMA_MAX_NODES))).toEqual({ ok: false });

    // Too deep to serialize: it is measured first, so nothing throws.
    expect(compileJsonSchema(nested(200_000))).toEqual({ ok: false });
  });
});

describe("a schema that is compiled", () => {
  // Fails without the change: `removeSchema` threw a TypeError for the `$id` below, out of
  // `compileJsonSchema` and into whoever built a tool list.
  it("is compiled by a validator of its own, which a malformed id cannot break", () => {
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    for (const id of [7, true, { a: 1 }, ["x"]] satisfies JsonValue[]) {
      expect(compileJsonSchema({ $id: id, type: "string" })).toEqual({ ok: false });
    }
    expect(compileJsonSchema({ type: "string", pattern: "(" })).toEqual({ ok: false });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }

    // What one schema names is not known to the next one.
    const named = compileJsonSchema({
      type: "object",
      properties: { month: { $id: "https://schemas.example.test/month", type: "string" } }
    });
    expect(named.ok).toBe(true);
    expect(compileJsonSchema({ $ref: "https://schemas.example.test/month" })).toEqual({
      ok: false
    });
    // Two schemas may carry the same id.
    const first = compileJsonSchema({ $id: "https://schemas.example.test/a", type: "string" });
    const second = compileJsonSchema({ $id: "https://schemas.example.test/a", type: "number" });
    expect(first.ok && first.validate("text")).toEqual([]);
    expect(second.ok && second.validate(4)).toEqual([]);
    expect(second.ok && second.validate("text")).not.toEqual([]);
  });

  it("is compiled again after it was dropped from a full cache", () => {
    const schema: JsonObject = { type: "object", required: ["first"] };
    const before = compileJsonSchema(schema);
    expect(compileJsonSchema(schema)).toBe(before);
    for (let index = 0; index < JSON_SCHEMA_CACHE_MAX_ENTRIES; index += 1) {
      // A schema that fails early costs nothing to compile and takes an entry all the same.
      compileJsonSchema({ $schema: `urn:unknown-dialect:${index}` });
    }
    const after = compileJsonSchema({ type: "object", required: ["first"] });
    expect(after).not.toBe(before);
    expect(after.ok && after.validate({})).toHaveLength(1);
    expect(after.ok && after.validate({ first: 1 })).toEqual([]);
  });
});

describe("an asynchronous schema", () => {
  // Fails without the change: the compiled function answered a promise, which read as a
  // value that fits, so `{}` passed a schema that requires `id`.
  it("is refused when it is compiled, in both dialects", () => {
    const required: JsonObject = { type: "object", required: ["id"] };
    expect(compileJsonSchema({ ...required, $async: true })).toEqual({ ok: false });
    expect(
      compileJsonSchema({
        ...required,
        $schema: "http://json-schema.org/draft-07/schema#",
        $async: true
      })
    ).toEqual({ ok: false });
    // Whatever the keyword holds: nobody here waits for a schema.
    expect(compileJsonSchema({ ...required, $async: false })).toEqual({ ok: false });

    const schema = jsonSchemaAsZod({ ...required, $async: true });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: 1 }).success).toBe(false);
    // The same schema without the keyword checks as it reads.
    expect(jsonSchemaAsZod(required).safeParse({ id: 1 }).success).toBe(true);
    expect(jsonSchemaAsZod(required).safeParse({}).success).toBe(false);
  });
});

describe("an asynchronous part of a schema", () => {
  // Fails without the change: only the keyword at the root was refused, so a schema that was
  // asynchronous in a definition or in a property compiled.
  it("is refused at any depth, whatever the keyword holds and also where nothing refers to it", () => {
    const part = (value: boolean): JsonObject => ({ type: "string", $async: value });
    const refused: JsonObject[] = [
      { type: "object", $defs: { unused: part(true) } },
      { type: "object", $defs: { unused: part(false) } },
      { type: "object", properties: { name: part(true) } },
      { type: "object", properties: { name: part(false) } },
      { type: "array", items: { anyOf: [{ type: "number" }, part(true)] } },
      { $ref: "#/$defs/node", $defs: { node: { $async: true, type: "object" } } },
      {
        $schema: "http://json-schema.org/draft-07/schema#",
        definitions: { unused: part(true) }
      }
    ];
    for (const schema of refused) {
      expect(compileJsonSchema(schema), JSON.stringify(schema)).toEqual({ ok: false });
      expect(isJsonSchemaWithinBounds(schema)).toBe(false);
      expect(jsonSchemaAsZod(schema).safeParse("x").success).toBe(false);
    }
    // The same shapes without the keyword compile.
    const plain: JsonObject = { type: "object", $defs: { unused: { type: "string" } } };
    expect(compileJsonSchema(plain).ok).toBe(true);
    expect(isJsonSchemaWithinBounds(plain)).toBe(true);
  });
});

describe("a value nested too deeply for a recursive schema", () => {
  // Fails without the change: the compiled function ran out of stack and `validate` threw a
  // RangeError, which a caller saw as an internal error.
  it("does not fit, and nothing is thrown", () => {
    const recursive: JsonObject = {
      $defs: { node: { type: "array", items: { $ref: "#/$defs/node" } } },
      $ref: "#/$defs/node"
    };
    let value: unknown[] = [];
    for (let level = 0; level < 200_000; level += 1) value = [value];

    const compiled = compileJsonSchema(recursive);
    if (!compiled.ok) throw new Error("the schema compiles");
    expect(compiled.validate([[[]]])).toEqual([]);
    expect(compiled.validate(value)).toEqual([
      { path: [], message: "is nested too deeply to check" }
    ]);
    const parsed = jsonSchemaAsZod(recursive).safeParse(value);
    expect(parsed.success).toBe(false);
    // The validator still works after it ran out of stack once.
    expect(compiled.validate([[], [[]]])).toEqual([]);
    expect(compiled.validate([7]).length).toBeGreaterThan(0);
  });
});

// Issue paths identify the checked value and can therefore be data. The message is safe
// for durable errors, provided callers format the path by position rather than copying it.
const dataKeySchemas: JsonObject[] = [
  { type: "object", additionalProperties: { type: "integer" } },
  { type: "object", additionalProperties: false },
  { type: "object", propertyNames: { pattern: "^[a-z]+$" } }
];
it.each(dataKeySchemas)("keeps checked keys out of the schema issue message for %j", (schema) => {
  const checked = compileJsonSchema(schema);
  if (!checked.ok) throw new Error("Probe schema did not compile");
  const sensitive = "Sensitive Person";
  const issues = checked.validate({ [sensitive]: "invalid" });
  expect(issues.length).toBeGreaterThan(0);
  expect(JSON.stringify(issues.map((issue) => issue.message)).includes(sensitive)).toBe(false);
});
