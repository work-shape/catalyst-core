import { describe, expect, it, vi } from "vitest";
import { JSON_SCHEMA_CACHE_MAX_ENTRIES, compileJsonSchema } from "@vivd-catalyst/connections";
import type { JsonObject, JsonValue } from "@vivd-catalyst/core";

// The JSON Schema an outside system may have written: what compiling one leaves behind.

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
